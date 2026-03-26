import { LEMONADE_DEFAULT_BASE_URL } from "openclaw/plugin-sdk/agent-runtime";
import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";

const LEMONADE_IMAGE_MODEL = "SDXL-Turbo";

type LemonadeImageResponse = {
  data?: { b64_json?: string }[];
};

export function buildLemonadeImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "lemonade",
    label: "Lemonade",
    defaultModel: LEMONADE_IMAGE_MODEL,
    models: [LEMONADE_IMAGE_MODEL],
    capabilities: {
      generate: {
        maxCount: 1,
        supportsSize: false,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      edit: {
        enabled: false,
        maxCount: 0,
        maxInputImages: 0,
      },
    },
    async generateImage(req) {
      const baseUrl = (
        req.cfg?.models?.providers?.lemonade?.baseUrl?.trim() || LEMONADE_DEFAULT_BASE_URL
      ).replace(/\/+$/u, "");

      const response = await fetch(`${baseUrl}/images/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer lemonade",
        },
        body: JSON.stringify({
          model: req.model || LEMONADE_IMAGE_MODEL,
          prompt: req.prompt,
          n: req.count ?? 1,
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `Lemonade image generation failed (${response.status}): ${text || response.statusText}`,
        );
      }

      const data = (await response.json()) as LemonadeImageResponse;
      const images = (data.data ?? [])
        .map((entry, index) => {
          if (!entry.b64_json) return null;
          return {
            buffer: Buffer.from(entry.b64_json, "base64"),
            mimeType: "image/png",
            fileName: `image-${index + 1}.png`,
          };
        })
        .filter((e): e is NonNullable<typeof e> => e !== null);

      if (images.length === 0) {
        throw new Error("Lemonade returned no images");
      }

      return { images, model: req.model || LEMONADE_IMAGE_MODEL };
    },
  };
}
