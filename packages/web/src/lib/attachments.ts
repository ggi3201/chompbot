import { apiFetch } from "./api";

export interface PendingAttachment {
  data: string;
  mimeType: string;
  name: string;
  size: number;
  /** Image-only — a data URL used to render the preview thumbnail. */
  preview?: string;
}

export interface UploadedAttachment {
  url: string;
  name: string;
  mimeType: string;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileToBase64(file: File): Promise<PendingAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const isImage = file.type.startsWith("image/");
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1];
      resolve({
        data: base64,
        mimeType: file.type || "application/octet-stream",
        name: file.name,
        size: file.size,
        preview: isImage ? result : undefined,
      });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function uploadAttachment(
  data: string,
  mimeType: string,
  name: string,
): Promise<UploadedAttachment | null> {
  try {
    const res = await apiFetch("/uploads", {
      method: "POST",
      body: JSON.stringify({ data, mimeType, name }),
    });
    if (res.ok) {
      const json = await res.json();
      return { url: json.url, name: json.name ?? name, mimeType: json.mimeType ?? mimeType };
    }
  } catch {
    // ignore
  }
  return null;
}

export function placeholderForUploads(uploads: UploadedAttachment[]): string {
  if (uploads.length === 0) return "";
  return uploads.every((u) => u.mimeType.startsWith("image/")) ? "[image]" : "[file]";
}
