import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";

const LEMONADE_IMAGE_MODEL = "Flux-2-Klein-9B-GGUF";
const LEMONADE_DEFAULT_BASE_URL = "http://localhost:8000/api/v1";

type LemonadeImageResponse = {
  data?: { b64_json?: string }[];
};

function parseLemonadeImages(data: LemonadeImageResponse): Array<{ buffer: Buffer; mimeType: string; fileName: string }> {
  return (data.data ?? [])
    .map((entry, index) => {
      if (!entry.b64_json) return null;
      return {
        buffer: Buffer.from(entry.b64_json, "base64"),
        mimeType: "image/png",
        fileName: `image-${index + 1}.png`,
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);
}

export function buildLemonadeImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "lemonade",
    label: "Lemonade",
    defaultModel: LEMONADE_IMAGE_MODEL,
    models: [LEMONADE_IMAGE_MODEL],
    capabilities: {
      generate: {
        maxCount: 1,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      edit: {
        enabled: true,
        maxCount: 1,
        maxInputImages: 1,
        supportsSize: true,
        supportsResolution: true,
        supportsAspectRatio: false,
      },
      geometry: {
        sizes: ["512x512", "768x768", "1024x1024"],
      },
    },
    async generateImage(req) {
      const baseUrl = (
        req.cfg?.models?.providers?.lemonade?.baseUrl?.trim() || LEMONADE_DEFAULT_BASE_URL
      ).replace(/\/+$/u, "");

      // FLUX-Klein is a distilled model — 8 steps at 768x768 balances quality and speed.
      // 1024x1024 with 20 steps doubles generation time and risks session timeouts.
      const size = req.size ?? "768x768";
      const [width, height] = size.split("x").map(Number);

      const inputImage = req.inputImages?.[0];

      if (inputImage) {
        // Image-to-image: POST /images/edits with multipart form data
        console.log(`[lemonade] image_generate → EDIT (img2img) | model=${req.model || LEMONADE_IMAGE_MODEL} size=${size} steps=8 cfg=3.5 inputImage=${inputImage.mimeType} ${inputImage.buffer.length}B`);
        const form = new FormData();
        form.append("model", req.model || LEMONADE_IMAGE_MODEL);
        form.append("prompt", req.prompt);
        form.append("n", String(req.count ?? 1));
        form.append("size", size);
        form.append("steps", "8");
        form.append("cfg_scale", "3.5");
        form.append(
          "image",
          new Blob([new Uint8Array(inputImage.buffer)], { type: inputImage.mimeType }),
          "image.png",
        );

        const editResponse = await fetch(`${baseUrl}/images/edits`, {
          method: "POST",
          headers: { Authorization: "Bearer lemonade" },
          body: form,
        });

        if (!editResponse.ok) {
          const text = await editResponse.text().catch(() => "");
          console.error(`[lemonade] EDIT failed | status=${editResponse.status} body=${text || editResponse.statusText}`);
          throw new Error(
            `Lemonade image edit failed (${editResponse.status}): ${text || editResponse.statusText}`,
          );
        }

        const editData = (await editResponse.json()) as LemonadeImageResponse;
        const editImages = parseLemonadeImages(editData);
        if (editImages.length === 0) {
          throw new Error("Lemonade returned no images from edit");
        }
        console.log(`[lemonade] EDIT complete | ${editImages.length} image(s) returned`);
        return { images: editImages, model: req.model || LEMONADE_IMAGE_MODEL };
      }

      // Text-to-image: POST /images/generations with JSON
      console.log(`[lemonade] image_generate → GENERATE (txt2img) | model=${req.model || LEMONADE_IMAGE_MODEL} size=${size} steps=8 cfg=3.5`);
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
          size,
          width,
          height,
          steps: 8,
          cfg_scale: 3.5,
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        console.error(`[lemonade] GENERATE failed | status=${response.status} body=${text || response.statusText}`);
        throw new Error(
          `Lemonade image generation failed (${response.status}): ${text || response.statusText}`,
        );
      }

      const data = (await response.json()) as LemonadeImageResponse;
      const images = parseLemonadeImages(data);
      if (images.length === 0) {
        throw new Error("Lemonade returned no images");
      }
      console.log(`[lemonade] GENERATE complete | ${images.length} image(s) returned`);
      return { images, model: req.model || LEMONADE_IMAGE_MODEL };
    },
  };
}
