import { afterEach, describe, expect, it, vi } from "vitest";

import { attachImages, dataUrl, fitInside, restoreAttachment, MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, MAX_IMAGES } from "./attachments";

/** A file of `size` bytes whose contents are known, so the base64 can be checked against them. */
function png(name: string, size: number): File {
  return new File([new Uint8Array(size).fill(0x41)], name, { type: "image/png" });
}

/**
 * Stand in for the decoder and the canvas jsdom does not implement, so the redrawing path can be run.
 *
 * The bitmap reports `width` by `height`; the canvas hands back three bytes spelling `PNG`, which is
 * enough to tell what was sent from what was read off the file.
 */
function stubBrowser(width: number, height: number) {
  const drawn: { width: number; height: number }[] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: (_image: unknown, _x: number, _y: number, w: number, h: number) => void drawn.push({ width: w, height: h }),
    }),
    toBlob: (done: (blob: Blob) => void, type: string) => done(new Blob([new Uint8Array([0x50, 0x4e, 0x47])], { type })),
  };
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width, height, close: () => {} })));
  const real = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(
    (tag: string) => (tag === "canvas" ? (canvas as unknown as HTMLElement) : real(tag)),
  );
  return { canvas, drawn };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("attachImages", () => {
  it("reads a pasted image into base64 the message can carry", async () => {
    const { attachments, rejected } = await attachImages([], [png("shot.png", 3)]);
    expect(rejected).toEqual([]);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].mimeType).toBe("image/png");
    expect(attachments[0].name).toBe("shot.png");
    expect(attachments[0].bytes).toBe(3);
    // "AAA" — three bytes of 0x41, and no `data:` prefix left on the front.
    expect(attachments[0].data).toBe("QUFB");
  });

  it("adds to what is already attached rather than replacing it", async () => {
    const first = await attachImages([], [png("a.png", 2)]);
    const second = await attachImages(first.attachments, [png("b.png", 2)]);
    expect(second.attachments.map((a) => a.name)).toEqual(["a.png", "b.png"]);
  });

  it("takes what fits and reports the rest, instead of failing as a whole", async () => {
    const files = [png("small.png", 8), png("huge.png", MAX_IMAGE_BYTES + 1), png("also.png", 8)];
    const { attachments, rejected } = await attachImages([], files);
    expect(attachments.map((a) => a.name)).toEqual(["small.png", "also.png"]);
    expect(rejected).toEqual([{ reason: "tooLarge", name: "huge.png" }]);
  });

  it("stops at the limit and says so", async () => {
    const files = Array.from({ length: MAX_IMAGES + 2 }, (_, i) => png(`s${i}.png`, 4));
    const { attachments, rejected } = await attachImages([], files);
    expect(attachments).toHaveLength(MAX_IMAGES);
    expect(rejected).toEqual([{ reason: "tooMany" }, { reason: "tooMany" }]);
  });

  it("redraws an image too large for the API down to the longest edge it accepts", async () => {
    const { canvas, drawn } = stubBrowser(3000, 1500);
    const { attachments } = await attachImages([], [png("wide.png", 64)]);
    expect(drawn).toEqual([{ width: MAX_IMAGE_EDGE, height: 784 }]);
    expect([canvas.width, canvas.height]).toEqual([MAX_IMAGE_EDGE, 784]);
    // "PNG" — the redrawn bytes, not the 0x41s the file is filled with.
    expect(attachments[0]).toMatchObject({ mimeType: "image/png", data: "UE5H", bytes: 3 });
  });

  it("sends a JPEG photograph back as a JPEG", async () => {
    stubBrowser(4000, 3000);
    const photo = new File([new Uint8Array(64)], "photo.jpg", { type: "image/jpeg" });
    const { attachments } = await attachImages([], [photo]);
    expect(attachments[0].mimeType).toBe("image/jpeg");
  });

  it("leaves an image that already fits exactly as it is", async () => {
    const { drawn } = stubBrowser(800, 600);
    const { attachments } = await attachImages([], [png("small.png", 3)]);
    expect(drawn).toEqual([]);
    expect(attachments[0]).toMatchObject({ mimeType: "image/png", data: "QUFB" });
  });

  it("sends the file untouched when the browser will not decode it", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => { throw new Error("unsupported"); }));
    const { attachments, rejected } = await attachImages([], [png("odd.png", 3)]);
    expect(rejected).toEqual([]);
    expect(attachments[0]).toMatchObject({ data: "QUFB" });
  });

  it("gives each attachment its own id, so removing one removes only that one", async () => {
    const { attachments } = await attachImages([], [png("a.png", 2), png("a.png", 2)]);
    expect(attachments[0].id).not.toBe(attachments[1].id);
  });
});

describe("dataUrl", () => {
  it("puts the prefix back for the browser to draw", () => {
    expect(dataUrl({ mimeType: "image/png", data: "QUFB" })).toBe("data:image/png;base64,QUFB");
  });
});

describe("restoreAttachment", () => {
  it.each([["QQ==", 1], ["QUE=", 2], ["QUFB", 3]] as const)("restores %s without changing its bytes", (data, bytes) => {
    const image = { mimeType: "image/webp", data };
    const restored = restoreAttachment(image, 1);
    expect(restored).toMatchObject({ ...image, name: "image-2.webp", bytes });
    expect(restored.id).not.toBe(restoreAttachment(image, 1).id);
    expect(image).toEqual({ mimeType: "image/webp", data });
  });
});

describe("fitInside", () => {
  it("leaves anything within the edge alone", () => {
    expect(fitInside(1568, 900)).toBeNull();
    expect(fitInside(0, 0)).toBeNull();
  });

  it("scales the longest edge down to the limit and keeps the shape", () => {
    expect(fitInside(3000, 1500)).toEqual({ width: 1568, height: 784 });
    expect(fitInside(1000, 4000)).toEqual({ width: 392, height: 1568 });
  });

  it("never rounds an edge away to nothing", () => {
    expect(fitInside(20000, 3)).toEqual({ width: 1568, height: 1 });
  });
});
