import { exec } from "node:child_process";
import { promisify } from "node:util";
import { ChannelType, type RequestClient } from "@buape/carbon";
import { resolveAckReaction, resolveHumanDelayConfig, EmbeddedBlockChunker, formatReasoningMessage } from "openclaw/plugin-sdk/agent-runtime";
import { EmbeddedBlockChunker } from "openclaw/plugin-sdk/agent-runtime";
import {
  createStatusReactionController,
  DEFAULT_TIMING,
  logAckFailure,
  logTypingFailure,
  shouldAckReaction as shouldAckReactionGate,
} from "openclaw/plugin-sdk/channel-feedback";
import {
  createChannelMessageReplyPipeline,
  defineFinalizableLivePreviewAdapter,
  deliverWithFinalizableLivePreviewAdapter,
  resolveChannelMessageSourceReplyDeliveryMode,
} from "openclaw/plugin-sdk/channel-message";
import {
  buildChannelProgressDraftLine,
  buildChannelProgressDraftLineForEntry,
  resolveChannelStreamingBlockEnabled,
} from "openclaw/plugin-sdk/channel-streaming";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import {
  hasFinalInboundReplyDispatch,
  runInboundReplyTurn,
} from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import { resolveChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveDiscordMaxLinesPerMessage } from "../accounts.js";
import { chunkDiscordTextWithMode } from "../chunk.js";
import { resolveDiscordDraftStreamingChunking } from "../draft-chunking.js";
import { createDiscordDraftStream } from "../draft-stream.js";
import { generateImage } from "openclaw/plugin-sdk/image-generation-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import { reactMessageDiscord, removeReactionDiscord, sendMessageDiscord } from "../send.js";
import { editMessageDiscord } from "../send.messages.js";
import { resolveDiscordTargetChannelId } from "../send.shared.js";
import { resolveDiscordChannelId } from "../targets.js";
import {
  createDiscordAckReactionAdapter,
  createDiscordAckReactionContext,
  queueInitialDiscordAckReaction,
} from "./ack-reactions.js";
import { buildDiscordMessageProcessContext } from "./message-handler.context.js";
import { createDiscordDraftPreviewController } from "./message-handler.draft-preview.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";
import { resolveForwardedMediaList, resolveMediaList } from "./message-utils.js";
import { deliverDiscordReply } from "./reply-delivery.js";
import {
  DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS,
  DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS,
} from "./timeouts.js";
import { sendTyping } from "./typing.js";

const execAsync = promisify(exec);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const DISCORD_TYPING_MAX_DURATION_MS = 20 * 60_000;
let replyRuntimePromise: Promise<typeof import("openclaw/plugin-sdk/reply-runtime")> | undefined;

async function loadReplyRuntime() {
  replyRuntimePromise ??= import("openclaw/plugin-sdk/reply-runtime");
  return await replyRuntimePromise;
}

function isProcessAborted(abortSignal?: AbortSignal): boolean {
  return Boolean(abortSignal?.aborted);
}

function formatDiscordReplyDeliveryFailure(params: {
  kind: string;
  err: unknown;
  target: string;
  sessionKey?: string;
}) {
  const context = [
    `target=${params.target}`,
    params.sessionKey ? `session=${params.sessionKey}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return `discord ${params.kind} reply failed (${context}): ${String(params.err)}`;
}

type DiscordMessageProcessObserver = {
  onFinalReplyStart?: () => void;
  onFinalReplyDelivered?: () => void;
  onReplyPlanResolved?: (params: { createdThreadId?: string; sessionKey?: string }) => void;
};

type ToolStartPayload = {
  name?: string;
  phase?: string;
  args?: Record<string, unknown>;
  detailMode?: "explain" | "raw";
};

function readToolStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readToolBooleanArg(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}

export async function processDiscordMessage(
  ctx: DiscordMessagePreflightContext,
  observer?: DiscordMessageProcessObserver,
) {
  const {
    cfg,
    discordConfig,
    accountId,
    token,
    runtime,
    guildHistories,
    historyLimit,
    mediaMaxBytes,
    textLimit,
    replyToMode,
    ackReactionScope,
    message,
    messageChannelId,
    isGuildMessage,
    isDirectMessage,
    isGroupDm,
    messageText,
    shouldRequireMention,
    canDetectMention,
    effectiveWasMentioned,
    shouldBypassMention,
    channelConfig,
    threadBindings,
    route,
    discordRestFetch,
    abortSignal,
  } = ctx;
  if (isProcessAborted(abortSignal)) {
    return;
  }

  const ssrfPolicy = cfg.browser?.ssrfPolicy;
  const mediaResolveOptions = {
    fetchImpl: discordRestFetch,
    ssrfPolicy,
    readIdleTimeoutMs: DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS,
    totalTimeoutMs: DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS,
    abortSignal,
  };
  const mediaList = await resolveMediaList(message, mediaMaxBytes, mediaResolveOptions);
  if (isProcessAborted(abortSignal)) {
    return;
  }
  const forwardedMediaList = await resolveForwardedMediaList(
    message,
    mediaMaxBytes,
    mediaResolveOptions,
  );
  if (isProcessAborted(abortSignal)) {
    return;
  }
  mediaList.push(...forwardedMediaList);
  const text = messageText;
  if (!text) {
    logVerbose("discord: drop message " + message.id + " (empty content)");
    return;
  }

  const boundThreadId = ctx.threadBinding?.conversation?.conversationId?.trim();
  if (boundThreadId && typeof threadBindings.touchThread === "function") {
    threadBindings.touchThread({ threadId: boundThreadId });
  }
  const { createReplyDispatcherWithTyping, dispatchInboundMessage, settleReplyDispatcher } =
    await loadReplyRuntime();
  const sourceReplyDeliveryMode = resolveChannelMessageSourceReplyDeliveryMode({
    cfg,
    ctx: { ChatType: isGuildMessage ? "channel" : undefined },
  });
  const sourceRepliesAreToolOnly = sourceReplyDeliveryMode === "message_tool_only";
  const ackReaction = resolveAckReaction(cfg, route.agentId, {
    channel: "discord",
    accountId,
  });
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
  const shouldAckReaction = () =>
    Boolean(
      ackReaction &&
      shouldAckReactionGate({
        scope: ackReactionScope,
        isDirect: isDirectMessage,
        isGroup: isGuildMessage || isGroupDm,
        isMentionableGroup: isGuildMessage,
        requireMention: shouldRequireMention,
        canDetectMention,
        effectiveWasMentioned,
        shouldBypassMention,
      }),
    );
  const shouldSendAckReaction = shouldAckReaction();
  const statusReactionsExplicitlyEnabled = cfg.messages?.statusReactions?.enabled === true;
  const statusReactionsEnabled =
    shouldSendAckReaction &&
    cfg.messages?.statusReactions?.enabled !== false &&
    (!sourceRepliesAreToolOnly || statusReactionsExplicitlyEnabled);
  const feedbackRest = createDiscordRestClient({
    cfg,
    token,
    accountId,
  }).rest;
  const deliveryRest = createDiscordRestClient({
    cfg,
    token,
    accountId,
  }).rest;
  // Discord outbound helpers expect the internal REST client shape explicitly.
  const ackReactionContext = createDiscordAckReactionContext({
    rest: feedbackRest,
    cfg,
    accountId,
  });
  const discordAdapter = createDiscordAckReactionAdapter({
    channelId: messageChannelId,
    messageId: message.id,
    reactionContext: ackReactionContext,
  });
  let statusReactionTarget = `${messageChannelId}/${message.id}`;
  let statusReactionsActive = statusReactionsEnabled;
  let statusReactions = createStatusReactionController({
    enabled: statusReactionsEnabled,
    adapter: discordAdapter,
    initialEmoji: ackReaction,
    emojis: cfg.messages?.statusReactions?.emojis,
    timing: cfg.messages?.statusReactions?.timing,
    onError: (err) => {
      logAckFailure({
        log: logVerbose,
        channel: "discord",
        target: statusReactionTarget,
        error: err,
      });
    },
  });
  const resolveTrackedReactionChannelId = async (
    args: Record<string, unknown>,
  ): Promise<string> => {
    const target =
      readToolStringArg(args, "channelId") ??
      readToolStringArg(args, "channel_id") ??
      readToolStringArg(args, "to");
    if (!target) {
      return messageChannelId;
    }
    try {
      return resolveDiscordChannelId(target);
    } catch {
      return (
        await resolveDiscordTargetChannelId(target, {
          cfg,
          token,
          accountId,
        })
      ).channelId;
    }
  };
  const maybeBindStatusReactionsToToolReaction = async (payload: ToolStartPayload) => {
    if (
      sourceRepliesAreToolOnly ||
      cfg.messages?.statusReactions?.enabled === false ||
      payload.phase !== "start" ||
      payload.name !== "message" ||
      !payload.args
    ) {
      return;
    }
    const args = payload.args;
    const action = readToolStringArg(args, "action")?.toLowerCase();
    if (action !== "react") {
      return;
    }
    const shouldTrack =
      readToolBooleanArg(args, "trackToolCalls") || readToolBooleanArg(args, "track_tool_calls");
    if (!shouldTrack) {
      return;
    }
    const emoji = readToolStringArg(args, "emoji");
    const remove = readToolBooleanArg(args, "remove");
    if (!emoji || remove) {
      return;
  if (statusReactionsEnabled) {
    void statusReactions.setQueued();
  }
  // Direct image generation: bypass LLM and pass message text straight to the image model.
  if (channelConfig?.directImageGen) {
    try {
      if (statusReactionsEnabled) {
        await statusReactions.setThinking();
      }
      const result = await generateImage({ cfg, prompt: text });
      const savedImages = await Promise.all(
        result.images.map((image, index) =>
          saveMediaBuffer(
            image.buffer,
            image.mimeType,
            "tool-image-generation",
            undefined,
            image.fileName ?? `image-${index + 1}.png`,
          ),
        ),
      );
      for (const saved of savedImages) {
        await sendMessageDiscord(`channel:${messageChannelId}`, "", {
          cfg,
          token,
          rest: discordRest,
          accountId,
          mediaUrl: saved.path,
          mediaLocalRoots,
          replyTo: message.id,
        });
      }
      if (statusReactionsEnabled) {
        await statusReactions.setDone();
        if (removeAckAfterReply) {
          void statusReactions.clear();
        } else {
          void statusReactions.restoreInitial();
        }
      }
    } catch (err) {
      runtime.error?.(danger(`discord direct image gen failed: ${String(err)}`));
      if (statusReactionsEnabled) {
        await statusReactions.setError();
      }
    }
    return;
  }

  const fromLabel = isDirectMessage
    ? buildDirectLabel(author)
    : buildGuildLabel({
        guild: data.guild ?? undefined,
        channelName: channelName ?? messageChannelId,
        channelId: messageChannelId,
      });
  const senderLabel = sender.label;
  const isForumParent =
    threadParentType === ChannelType.GuildForum || threadParentType === ChannelType.GuildMedia;
  const forumParentSlug =
    isForumParent && threadParentName ? normalizeDiscordSlug(threadParentName) : "";
  const threadChannelId = threadChannel?.id;
  const isForumStarter =
    Boolean(threadChannelId && isForumParent && forumParentSlug) && message.id === threadChannelId;
  const forumContextLine = isForumStarter ? `[Forum parent: #${forumParentSlug}]` : null;
  const groupChannel = isGuildMessage && displayChannelSlug ? `#${displayChannelSlug}` : undefined;
  const groupSubject = isDirectMessage ? undefined : groupChannel;
  const senderName = sender.isPluralKit
    ? (sender.name ?? author.username)
    : (data.member?.nickname ?? author.globalName ?? author.username);
  const senderUsername = sender.isPluralKit
    ? (sender.tag ?? sender.name ?? author.username)
    : author.username;
  const senderTag = sender.tag;
  const { groupSystemPrompt, ownerAllowFrom, untrustedContext } = buildDiscordInboundAccessContext({
    channelConfig,
    guildInfo,
    sender: { id: sender.id, name: sender.name, tag: sender.tag },
    allowNameMatching: isDangerousNameMatchingEnabled(discordConfig),
    isGuild: isGuildMessage,
    channelTopic: channelInfo?.topic,
    messageBody: text,
  });
  let dynamicGroupSystemPrompt = groupSystemPrompt;
  if (channelConfig?.preRunScript?.trim() && isGuildMessage) {
    try {
      const { stdout } = await execAsync(channelConfig.preRunScript, {
        timeout: 180_000,
        maxBuffer: 100 * 1024,
        env: {
          ...process.env,
          OPENCLAW_USER_MESSAGE: text,
          OPENCLAW_CHANNEL_ID: messageChannelId,
        },
      });
      const scriptOutput = stdout.trim();
      if (scriptOutput) {
        dynamicGroupSystemPrompt = [groupSystemPrompt, scriptOutput]
          .filter(Boolean)
          .join("\n\n");
      }
    } catch (err) {
      logVerbose(
        `discord: preRunScript failed for channel ${messageChannelId}: ${String(err)}`,
      );
    }
  }
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  let combinedBody = formatInboundEnvelope({
    channel: "Discord",
    from: fromLabel,
    timestamp: resolveTimestampMs(message.timestamp),
    body: text,
    chatType: isDirectMessage ? "direct" : "channel",
    senderLabel,
    previousTimestamp,
    envelope: envelopeOptions,
  });
  const shouldIncludeChannelHistory =
    !isDirectMessage && !(isGuildMessage && channelConfig?.autoThread && !threadChannel);
  if (shouldIncludeChannelHistory) {
    combinedBody = buildPendingHistoryContextFromMap({
      historyMap: guildHistories,
      historyKey: messageChannelId,
      limit: historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatInboundEnvelope({
          channel: "Discord",
          from: fromLabel,
          timestamp: entry.timestamp,
          body: `${entry.body} [id:${entry.messageId ?? "unknown"} channel:${messageChannelId}]`,
          chatType: "channel",
          senderLabel: entry.sender,
          envelope: envelopeOptions,
        }),
    });
  }
  const replyContext = resolveReplyContext(message, resolveDiscordMessageText);
  if (forumContextLine) {
    combinedBody = `${combinedBody}\n${forumContextLine}`;
  }

  let threadStarterBody: string | undefined;
  let threadLabel: string | undefined;
  let parentSessionKey: string | undefined;
  if (threadChannel) {
    const includeThreadStarter = channelConfig?.includeThreadStarter !== false;
    if (includeThreadStarter) {
      const starter = await resolveDiscordThreadStarter({
        channel: threadChannel,
        client,
        parentId: threadParentId,
        parentType: threadParentType,
        resolveTimestampMs,
      });
      if (starter?.text) {
        // Keep thread starter as raw text; metadata is provided out-of-band in the system prompt.
        threadStarterBody = starter.text;
      }
    }
    const trackedMessageId =
      readToolStringArg(args, "messageId") ?? readToolStringArg(args, "message_id") ?? message.id;
    let trackedChannelId: string;
    try {
      trackedChannelId = await resolveTrackedReactionChannelId(args);
    } catch (err) {
      logAckFailure({
        log: logVerbose,
        channel: "discord",
        target: `${readToolStringArg(args, "to") ?? readToolStringArg(args, "channelId") ?? messageChannelId}/${trackedMessageId}`,
        error: err,
      });
      return;
    }
    statusReactionTarget = `${trackedChannelId}/${trackedMessageId}`;
    if (statusReactionsActive) {
      void statusReactions.clear();
    }
    const trackedAdapter = createDiscordAckReactionAdapter({
      channelId: trackedChannelId,
      messageId: trackedMessageId,
      reactionContext: ackReactionContext,
    });
    statusReactions = createStatusReactionController({
      enabled: true,
      adapter: trackedAdapter,
      initialEmoji: emoji,
      emojis: cfg.messages?.statusReactions?.emojis,
      timing: cfg.messages?.statusReactions?.timing,
      onError: (err) => {
        logAckFailure({
          log: logVerbose,
          channel: "discord",
          target: statusReactionTarget,
          error: err,
        });
      },
    });
    statusReactionsActive = true;
    void statusReactions.setQueued();
  };
  queueInitialDiscordAckReaction({
    enabled: statusReactionsEnabled,
    shouldSendAckReaction,
    ackReaction,
    statusReactions,
    reactionAdapter: discordAdapter,
    target: `${messageChannelId}/${message.id}`,
  });
  const processContext = await buildDiscordMessageProcessContext({
    ctx,
    text,
    mediaList,
  });
  if (!processContext) {
    return;
  }
  const {
    ctxPayload,
    persistedSessionKey,
    turn,
    replyPlan,
    deliverTarget,
    replyTarget,
    replyReference,
  } = processContext;
  // Keep DM routes user-addressed so follow-up sends resolve direct session keys.
  const lastRouteTo = isDirectMessage ? `user:${author.id}` : effectiveTo;

  const inboundHistory =
    shouldIncludeChannelHistory && historyLimit > 0
      ? (guildHistories.get(messageChannelId) ?? []).map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        }))
      : undefined;

  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: baseText ?? text,
    InboundHistory: inboundHistory,
    RawBody: baseText,
    CommandBody: baseText,
    From: effectiveFrom,
    To: effectiveTo,
    SessionKey: boundSessionKey ?? autoThreadContext?.SessionKey ?? threadKeys.sessionKey,
    AccountId: route.accountId,
    ChatType: isDirectMessage ? "direct" : "channel",
    ConversationLabel: fromLabel,
    SenderName: senderName,
    SenderId: sender.id,
    SenderUsername: senderUsername,
    SenderTag: senderTag,
    GroupSubject: groupSubject,
    GroupChannel: groupChannel,
    UntrustedContext: untrustedContext,
    GroupSystemPrompt: isGuildMessage ? dynamicGroupSystemPrompt : undefined,
    GroupSpace: isGuildMessage ? (guildInfo?.id ?? guildSlug) || undefined : undefined,
    OwnerAllowFrom: ownerAllowFrom,
    Provider: "discord" as const,
    Surface: "discord" as const,
    WasMentioned: effectiveWasMentioned,
    MessageSid: message.id,
    ReplyToId: replyContext?.id,
    ReplyToBody: replyContext?.body,
    ReplyToSender: replyContext?.sender,
    ParentSessionKey: autoThreadContext?.ParentSessionKey ?? threadKeys.parentSessionKey,
    MessageThreadId: threadChannel?.id ?? autoThreadContext?.createdThreadId ?? undefined,
    ThreadStarterBody: threadStarterBody,
    ThreadLabel: threadLabel,
    Timestamp: resolveTimestampMs(message.timestamp),
    ...mediaPayload,
    CommandAuthorized: commandAuthorized,
    CommandSource: "text" as const,
    // Originating channel for reply routing.
    OriginatingChannel: "discord" as const,
    OriginatingTo: autoThreadContext?.OriginatingTo ?? replyTarget,
  });
  const persistedSessionKey = ctxPayload.SessionKey ?? route.sessionKey;
  observer?.onReplyPlanResolved?.({
    createdThreadId: replyPlan.createdThreadId,
    sessionKey: persistedSessionKey,
  });

  const typingChannelId = deliverTarget.startsWith("channel:")
    ? deliverTarget.slice("channel:".length)
    : messageChannelId;

  const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
    cfg,
    agentId: route.agentId,
    channel: "discord",
    accountId: route.accountId,
    typing: {
      start: () => sendTyping({ rest: feedbackRest, channelId: typingChannelId }),
      onStartError: (err) => {
        logTypingFailure({
          log: logVerbose,
          channel: "discord",
          target: typingChannelId,
          error: err,
        });
      },
      // Long tool-heavy runs are expected on Discord; keep heartbeats alive.
      maxDurationMs: DISCORD_TYPING_MAX_DURATION_MS,
    },
  });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "discord",
    accountId,
  });
  const maxLinesPerMessage = resolveDiscordMaxLinesPerMessage({
    cfg,
    discordConfig,
    accountId,
  });
  const chunkMode = resolveChunkMode(cfg, "discord", accountId);

  const deliverChannelId = deliverTarget.startsWith("channel:")
    ? deliverTarget.slice("channel:".length)
    : messageChannelId;
  const draftPreview = createDiscordDraftPreviewController({
    cfg,
    discordConfig,
    accountId,
    sourceRepliesAreToolOnly,
    textLimit,
    deliveryRest,
    deliverChannelId,
    replyReference,
    tableMode,
    maxLinesPerMessage,
    chunkMode,
    log: logVerbose,
  });
  let finalReplyStartNotified = false;
  const notifyFinalReplyStart = () => {
    if (finalReplyStartNotified) {
      return;
    }
    finalReplyStartNotified = true;
    observer?.onFinalReplyStart?.();
  };

  const { dispatcher, replyOptions, markDispatchIdle, markRunComplete } =
    createReplyDispatcherWithTyping({
      ...replyPipeline,
      humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
      deliver: async (payload: ReplyPayload, info) => {
        if (isProcessAborted(abortSignal)) {
          return;
        }
        const isFinal = info.kind === "final";
        if (payload.isReasoning) {
          // Reasoning/thinking payloads should not be delivered to Discord.
          return;
        }
        const draftStream = draftPreview.draftStream;
        if (draftStream && draftPreview.isProgressMode && info.kind === "block") {
          const reply = resolveSendableOutboundReplyParts(payload);
          if (!reply.hasMedia && !payload.isError) {
            return;
          }
        }
        if (
          draftStream &&
          isFinal &&
          (!draftPreview.isProgressMode || draftPreview.hasProgressDraftStarted)
        ) {
          draftPreview.markFinalDeliveryHandled();
          const reply = resolveSendableOutboundReplyParts(payload);
          const hasMedia = reply.hasMedia;
          const finalText = payload.text;
          const previewFinalText = draftPreview.resolvePreviewFinalText(finalText);
          const hasExplicitReplyDirective =
            Boolean(payload.replyToTag || payload.replyToCurrent) ||
            (typeof finalText === "string" && /\[\[\s*reply_to(?:_current|\s*:)/i.test(finalText));

          const result = await deliverWithFinalizableLivePreviewAdapter({
            kind: info.kind,
            payload,
            adapter: defineFinalizableLivePreviewAdapter({
              draft: {
                flush: () => draftPreview.flush(),
                clear: () => draftStream.clear(),
                discardPending: () => draftStream.discardPending(),
                seal: () => draftStream.seal(),
                id: draftStream.messageId,
              },
              buildFinalEdit: () => {
                if (
                  draftPreview.finalizedViaPreviewMessage ||
                  hasMedia ||
                  typeof previewFinalText !== "string" ||
                  hasExplicitReplyDirective ||
                  payload.isError
                ) {
                  return undefined;
                }
                return { content: previewFinalText };
              },
              editFinal: async (previewMessageId, edit) => {
                if (isProcessAborted(abortSignal)) {
                  throw new Error("process aborted");
                }
                notifyFinalReplyStart();
                await editMessageDiscord(deliverChannelId, previewMessageId, edit, {
                  cfg,
                  accountId,
                  rest: deliveryRest,
                });
              },
              onPreviewFinalized: () => {
                draftPreview.markPreviewFinalized();
                replyReference.markSent();
                observer?.onFinalReplyDelivered?.();
              },
              logPreviewEditFailure: (err) => {
                logVerbose(
                  `discord: preview final edit failed; falling back to standard send (${String(err)})`,
                );
              },
            }),
            deliverNormally: async () => {
              if (isProcessAborted(abortSignal)) {
                return false;
              }
              const replyToId = replyReference.use();
              notifyFinalReplyStart();
              await deliverDiscordReply({
                cfg,
                replies: [payload],
                target: deliverTarget,
                token,
                accountId,
                rest: deliveryRest,
                runtime,
                replyToId,
                replyToMode,
                textLimit,
                maxLinesPerMessage,
                tableMode,
                chunkMode,
                sessionKey: ctxPayload.SessionKey,
                threadBindings,
                mediaLocalRoots,
              });
              replyReference.markSent();
              observer?.onFinalReplyDelivered?.();
              return true;
            },
          });
          if (result.kind !== "normal-skipped") {
            return;
          }
        }
        if (isProcessAborted(abortSignal)) {
          return;
        }

        const replyToId = replyReference.use();
        if (isFinal) {
          notifyFinalReplyStart();
        }
        await deliverDiscordReply({
          cfg,
          replies: [payload],
          target: deliverTarget,
          token,
          accountId,
          rest: deliveryRest,
          runtime,
          replyToId,
          replyToMode,
          textLimit,
          maxLinesPerMessage,
          tableMode,
          chunkMode,
          sessionKey: ctxPayload.SessionKey,
          threadBindings,
          mediaLocalRoots,
        });
        replyReference.markSent();
        if (isFinal) {
          observer?.onFinalReplyDelivered?.();
        }
      },
      onError: (err, info) => {
        runtime.error?.(
          danger(
            formatDiscordReplyDeliveryFailure({
              kind: info.kind,
              err,
              target: deliverTarget,
              sessionKey: ctxPayload.SessionKey,
            }),
          ),
        );
      },
      onReplyStart: async () => {
        if (isProcessAborted(abortSignal)) {
          return;
        }
        await replyPipeline.typingCallbacks?.onReplyStart();
        await statusReactions.setThinking();
      },
    });

  const resolvedBlockStreamingEnabled = resolveChannelStreamingBlockEnabled(discordConfig);
  let dispatchResult: Awaited<ReturnType<typeof dispatchInboundMessage>> | null = null;
  let dispatchError = false;
  let dispatchAborted = false;
  let dispatchSettledBeforeStart = false;
  const settleDispatchBeforeStart = async () => {
    dispatchSettledBeforeStart = true;
    await settleReplyDispatcher({
      dispatcher,
      onSettled: () => {
        markRunComplete();
        markDispatchIdle();
      },
    });
  };
  try {
    if (isProcessAborted(abortSignal)) {
      dispatchAborted = true;
      await settleDispatchBeforeStart();
      return;
    }
    const preparedResult = await runInboundReplyTurn({
      channel: "discord",
      accountId: route.accountId,
      raw: ctx,
      adapter: {
        ingest: () => ({
          id: message.id,
          timestamp: message.timestamp ? Date.parse(message.timestamp) : undefined,
          rawText: text,
          textForAgent: ctxPayload.BodyForAgent,
          textForCommands: ctxPayload.CommandBody,
          raw: message,
        }),
        resolveTurn: () => ({
          channel: "discord",
          accountId: route.accountId,
          routeSessionKey: persistedSessionKey,
          storePath: turn.storePath,
          ctxPayload,
          recordInboundSession,
          record: turn.record,
          history: {
            isGroup: isGuildMessage,
            historyKey: messageChannelId,
            historyMap: guildHistories,
            limit: historyLimit,
          },
          onPreDispatchFailure: settleDispatchBeforeStart,
          runDispatch: async () => {
            return await dispatchInboundMessage({
              ctx: ctxPayload,
              cfg,
              dispatcher,
              replyOptions: {
                ...replyOptions,
                abortSignal,
                skillFilter: channelConfig?.skills,
                sourceReplyDeliveryMode,
                disableBlockStreaming: sourceRepliesAreToolOnly
                  ? true
                  : (draftPreview.disableBlockStreamingForDraft ??
                    (typeof resolvedBlockStreamingEnabled === "boolean"
                      ? !resolvedBlockStreamingEnabled
                      : undefined)),
                onPartialReply: draftPreview.draftStream
                  ? (payload) => draftPreview.updateFromPartial(payload.text)
                  : undefined,
                onAssistantMessageStart: draftPreview.draftStream
                  ? () => draftPreview.handleAssistantMessageBoundary()
                  : undefined,
                onReasoningEnd: draftPreview.draftStream
                  ? () => draftPreview.handleAssistantMessageBoundary()
                  : undefined,
                onModelSelected,
                suppressDefaultToolProgressMessages:
                  draftPreview.suppressDefaultToolProgressMessages ? true : undefined,
                onReasoningStream: async (payload) => {
                  await statusReactions.setThinking();
                  const formattedText = payload?.text
                    ? formatReasoningMessage(payload.text)
                    : undefined;
                  await draftPreview.pushReasoningProgress(formattedText);
                },
                onToolStart: async (payload) => {
                  if (isProcessAborted(abortSignal)) {
                    return;
                  }
                  await maybeBindStatusReactionsToToolReaction(payload);
                  await statusReactions.setTool(payload.name);
                  await draftPreview.pushToolProgress(
                    buildChannelProgressDraftLineForEntry(
                      discordConfig,
                      {
                        event: "tool",
                        name: payload.name,
                        phase: payload.phase,
                        args: payload.args,
                      },
                      payload.detailMode ? { detailMode: payload.detailMode } : undefined,
                    ),
                    { toolName: payload.name },
                  );
                },
                onItemEvent: async (payload) => {
                  await draftPreview.pushToolProgress(
                    buildChannelProgressDraftLineForEntry(discordConfig, {
                      event: "item",
                      itemKind: payload.kind,
                      title: payload.title,
                      name: payload.name,
                      phase: payload.phase,
                      status: payload.status,
                      summary: payload.summary,
                      progressText: payload.progressText,
                      meta: payload.meta,
                    }),
                  );
                },
                onPlanUpdate: async (payload) => {
                  if (payload.phase !== "update") {
                    return;
                  }
                  await draftPreview.pushToolProgress(
                    buildChannelProgressDraftLine({
                      event: "plan",
                      phase: payload.phase,
                      title: payload.title,
                      explanation: payload.explanation,
                      steps: payload.steps,
                    }),
                  );
                },
                onApprovalEvent: async (payload) => {
                  if (payload.phase !== "requested") {
                    return;
                  }
                  await draftPreview.pushToolProgress(
                    buildChannelProgressDraftLine({
                      event: "approval",
                      phase: payload.phase,
                      title: payload.title,
                      command: payload.command,
                      reason: payload.reason,
                      message: payload.message,
                    }),
                  );
                },
                onCommandOutput: async (payload) => {
                  if (payload.phase !== "end") {
                    return;
                  }
                  await draftPreview.pushToolProgress(
                    buildChannelProgressDraftLine({
                      event: "command-output",
                      phase: payload.phase,
                      title: payload.title,
                      name: payload.name,
                      status: payload.status,
                      exitCode: payload.exitCode,
                    }),
                  );
                },
                onPatchSummary: async (payload) => {
                  if (payload.phase !== "end") {
                    return;
                  }
                  await draftPreview.pushToolProgress(
                    buildChannelProgressDraftLine({
                      event: "patch",
                      phase: payload.phase,
                      title: payload.title,
                      name: payload.name,
                      added: payload.added,
                      modified: payload.modified,
                      deleted: payload.deleted,
                      summary: payload.summary,
                    }),
                  );
                },
                onCompactionStart: async () => {
                  if (isProcessAborted(abortSignal)) {
                    return;
                  }
                  await statusReactions.setCompacting();
                },
                onCompactionEnd: async () => {
                  if (isProcessAborted(abortSignal)) {
                    return;
                  }
                  statusReactions.cancelPending();
                  await statusReactions.setThinking();
                },
              },
            });
          },
        }),
      },
    });
    if (!preparedResult.dispatched) {
      return;
    }
    dispatchResult = preparedResult.dispatchResult;
    if (isProcessAborted(abortSignal)) {
      dispatchAborted = true;
      return;
    }
  } catch (err) {
    if (isProcessAborted(abortSignal)) {
      dispatchAborted = true;
      return;
    }
    dispatchError = true;
    throw err;
  } finally {
    try {
      await draftPreview.cleanup();
    } finally {
      if (!dispatchSettledBeforeStart) {
        markRunComplete();
        markDispatchIdle();
      }
    }
    const finalDeliveryFailed = (dispatchResult?.failedCounts?.final ?? 0) > 0;
    if (statusReactionsActive) {
      if (dispatchAborted) {
        if (removeAckAfterReply) {
          void statusReactions.clear();
        } else {
          void statusReactions.restoreInitial();
        }
      } else {
        if (dispatchError || finalDeliveryFailed) {
          await statusReactions.setError();
        } else {
          await statusReactions.setDone();
        }
        if (removeAckAfterReply) {
          void (async () => {
            await sleep(
              dispatchError || finalDeliveryFailed
                ? DEFAULT_TIMING.errorHoldMs
                : DEFAULT_TIMING.doneHoldMs,
            );
            await statusReactions.clear();
          })();
        } else {
          void statusReactions.restoreInitial();
        }
      }
    } else if (shouldSendAckReaction && ackReaction && removeAckAfterReply) {
      void removeReactionDiscord(
        messageChannelId,
        message.id,
        ackReaction,
        ackReactionContext,
      ).catch((err: unknown) => {
        logAckFailure({
          log: logVerbose,
          channel: "discord",
          target: `${messageChannelId}/${message.id}`,
          error: err,
        });
      });
    }
  }
  if (dispatchAborted) {
    return;
  }

  const finalDispatchResult = dispatchResult;
  if (!finalDispatchResult || !hasFinalInboundReplyDispatch(finalDispatchResult)) {
    return;
  }
  if (shouldLogVerbose()) {
    const finalCount = finalDispatchResult.counts.final;
    logVerbose(
      `discord: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`,
    );
  }
}
