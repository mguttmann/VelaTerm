//! Images waiting in the composer, from the moment they are pasted or dropped until they are sent.
//!
//! The chat engine takes an image as base64 inside the message itself, so nothing is written to disk on the
//! way — unlike the terminal path in `terminal/imageInput.ts`, which uploads a file and types its path,
//! because a terminal can only carry text. What the two share is how an image is fished out of a paste or a
//! drop, and that part is reused rather than written twice.
//!
//! An image wider or taller than `MAX_IMAGE_EDGE` is redrawn smaller before it is sent. See that constant
//! for why.

import { genId } from "../../../genId";
import type { ChatImage, ChatImageValue } from "../../../ipc/chat";

/**
 * How much can ride along with one message.
 *
 * The same numbers are enforced in `command_core::chat_send`. They are here as well so that a file too
 * large is refused before it is read, and refused in words the reader can act on rather than as a failure
 * coming back from the backend.
 */
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * The longest edge an image is sent at.
 *
 * Two reasons for redrawing anything larger. An image costs tokens by its pixel count alone, and Anthropic
 * scales everything past this edge down to it anyway, so those pixels are paid for and then discarded. And
 * once a request carries more than twenty images, the API refuses any image measuring 2000px or more —
 * which is exactly where Claude Code's own resizing leaves a large screenshot, so a long conversation full
 * of screenshots eventually fails as a whole. Arriving under that figure keeps both problems away.
 */
export const MAX_IMAGE_EDGE = 1568;

/** One image held in the composer, not yet sent. */
export interface Attachment extends ChatImage {
  /** Identifies the thumbnail while it is on screen; never leaves the frontend. */
  id: string;
  /** The file's own name, shown as the thumbnail's tooltip. */
  name: string;
  /** Size in bytes of what is sent, before base64 — smaller than the file when the image was redrawn. */
  bytes: number;
}

/** Why a file was left out, in the terms the composer explains it in. */
export type Rejection =
  | { reason: "tooMany" }
  | { reason: "tooLarge"; name: string }
  | { reason: "unreadable"; name: string };

export interface AttachResult<T extends ChatImageValue = Attachment> {
  /** The attachments the composer should hold now: what it had, plus whatever was accepted. */
  attachments: (T | Attachment)[];
  /** Everything left out, in the order it was offered. Empty when all of it was taken. */
  rejected: Rejection[];
}

/** What an `<img>` needs to draw one of these. */
export function dataUrl(image: ChatImage): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

/** Restore a sent image to the composer. History retains its bytes and type, but not its filename. */
export function restoreAttachment(image: ChatImage, index: number): Attachment {
  return {
    ...image,
    id: genId(),
    name: `image-${index + 1}.${image.mimeType.split("/")[1] || "png"}`,
    bytes: decodedBytes(image.data),
  };
}

/** How many bytes a base64 string stands for, counted from its length rather than by decoding it. */
function decodedBytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor(data.length * 3 / 4) - padding;
}

/**
 * The size an image is redrawn at, or `null` when it already fits within `MAX_IMAGE_EDGE`.
 *
 * Separate from the drawing so the arithmetic can be read and tested without a canvas.
 */
export function fitInside(width: number, height: number, edge = MAX_IMAGE_EDGE): { width: number; height: number } | null {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= edge) return null;
  const scale = edge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * An oversized image redrawn small enough to send, or `null` to send the file's own bytes instead.
 *
 * `null` covers an image that already fits and an image this browser will not decode or draw — an SVG, a
 * damaged file, a canvas that refuses a context. Sending the original in those cases is what happened
 * before this step existed, so nothing an agent used to accept becomes unattachable here.
 */
async function shrink(file: File): Promise<ChatImage | null> {
  if (typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const size = fitInside(bitmap.width, bitmap.height);
    if (!size) return null;
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    // A photograph stays a photograph; anything else becomes PNG, which is where the flat colour and the
    // small text of a screenshot survive being redrawn. The quality figure only reaches the JPEG branch.
    const mimeType = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, 0.92));
    return blob ? { mimeType, data: await readBase64(blob) } : null;
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}

/**
 * Read files into attachments, refusing what does not fit.
 *
 * A file that is too large, or one file too many, is left out while the rest are taken: dropping a folder
 * of screenshots should attach what it can and say what it could not, rather than fail as a whole.
 * Retained history references keep their object identity so their snapshot context remains available.
 */
export async function attachImages<T extends ChatImageValue = Attachment>(current: T[], files: File[]): Promise<AttachResult<T>> {
  const attachments: (T | Attachment)[] = current.slice();
  const rejected: Rejection[] = [];
  for (const file of files) {
    if (attachments.length >= MAX_IMAGES) {
      rejected.push({ reason: "tooMany" });
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      rejected.push({ reason: "tooLarge", name: file.name });
      continue;
    }
    try {
      const image = await shrink(file) ?? { mimeType: file.type || "image/png", data: await readBase64(file) };
      attachments.push({ id: genId(), name: file.name, ...image, bytes: decodedBytes(image.data) });
    } catch {
      rejected.push({ reason: "unreadable", name: file.name });
    }
  }
  return { attachments, rejected };
}

/**
 * The bytes as base64, without the `data:` prefix the reader puts in front of them.
 *
 * `FileReader` rather than `arrayBuffer()` and a hand-rolled encoder: the browser already does this, and
 * doing it by hand means walking a multi-megabyte array in JavaScript for no gain.
 */
function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read the image"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) {
        reject(new Error("Failed to read the image"));
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}
