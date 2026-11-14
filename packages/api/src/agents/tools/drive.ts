/**
 * Google Drive tools — list files within a sandboxed root folder.
 */

import { googleFetch } from "./google-common.js";
import { db } from "../../db/index.js";
import { settings } from "../../db/schema.js";
import { eq } from "drizzle-orm";

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Read the configured root Drive folder ID from the settings table.
 * Throws if not configured.
 */
function getRootFolderId(): string {
  const row = db
    .select()
    .from(settings)
    .where(eq(settings.key, "drive_folder_id"))
    .get();

  if (!row?.value) {
    throw new Error(
      "Google Drive root folder is not configured. Set 'drive_folder_id' in Settings before using Drive tools.",
    );
  }

  return row.value;
}

/**
 * Walk the parent chain via Drive API to verify that `fileId` is a descendant
 * of `rootId`. Max 20 levels deep; uses a `seen` set to prevent loops.
 */
async function isInsideRoot(fileId: string, rootId: string): Promise<boolean> {
  if (fileId === rootId) return true;

  const seen = new Set<string>();
  let current = fileId;

  for (let depth = 0; depth < 20; depth++) {
    if (seen.has(current)) return false; // cycle detected
    seen.add(current);

    const res = await googleFetch(
      `${DRIVE_BASE}/files/${encodeURIComponent(current)}?fields=parents`,
    );

    if (!res.ok) return false; // can't verify — treat as outside root

    const data = (await res.json()) as { parents?: string[] };
    if (!data.parents || data.parents.length === 0) return false;

    for (const parent of data.parents) {
      if (parent === rootId) return true;
    }

    // Continue walking up the first parent
    current = data.parents[0];
  }

  return false; // exceeded depth limit
}

/**
 * Resolve a folder ID for operations. If no `folderId` is given, returns the
 * configured root. Otherwise validates the folder is inside the root.
 */
async function resolveFolder(
  folderId?: string,
): Promise<{ id: string; error?: string }> {
  const rootId = getRootFolderId();

  if (!folderId) {
    return { id: rootId };
  }

  const inside = await isInsideRoot(folderId, rootId);
  if (!inside) {
    return {
      id: folderId,
      error: `Folder ${folderId} is not inside the configured root Drive folder. Access denied.`,
    };
  }

  return { id: folderId };
}

/**
 * Format a byte count into a human-readable size string.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ── List Files ───────────────────────────────────────────────────

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
}

interface DriveListResponse {
  files?: DriveFile[];
}

export async function execListDriveFiles(
  folderId?: string,
  pageSize?: number,
): Promise<string> {
  const folder = await resolveFolder(folderId);
  if (folder.error) return `ERROR: ${folder.error}`;

  const q = `'${folder.id}' in parents and trashed = false`;
  const params = new URLSearchParams({
    q,
    fields: "files(id,name,mimeType,size,modifiedTime)",
    orderBy: "folder,name",
    pageSize: String(Math.min(pageSize ?? 50, 100)),
  });

  const res = await googleFetch(`${DRIVE_BASE}/files?${params}`);
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    return `ERROR: Drive list failed (${res.status}): ${err.slice(0, 200)}`;
  }

  const data = (await res.json()) as DriveListResponse;

  if (!data.files || data.files.length === 0) {
    return "No files found in this folder.";
  }

  const lines = data.files.map((f) => {
    const isFolder = f.mimeType === "application/vnd.google-apps.folder";
    const type = isFolder ? "[folder]" : "[file]  ";
    const size = f.size ? formatSize(Number(f.size)) : "—";
    const modified = f.modifiedTime
      ? new Date(f.modifiedTime).toLocaleString()
      : "—";
    return `${type} ${f.name}  (${size}, ${modified})  ID: ${f.id}`;
  });

  return `${data.files.length} item(s):\n` + lines.join("\n");
}

// ── Upload File ─────────────────────────────────────────────────

export async function execUploadDriveFile(
  filename: string,
  contentBase64: string,
  mimeType: string,
  folderId?: string,
): Promise<string> {
  const folder = await resolveFolder(folderId);
  if (folder.error) return `ERROR: ${folder.error}`;

  const boundary = "chomp_drive_boundary";
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify({ name: filename, parents: [folder.id] }),
    `--${boundary}`,
    `Content-Type: ${mimeType}`,
    "Content-Transfer-Encoding: base64",
    "",
    contentBase64,
    `--${boundary}--`,
  ].join("\r\n");

  const res = await googleFetch(
    `${UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,webViewLink,size`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
      timeoutMs: 120_000,
    },
  );

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    return `ERROR: Drive upload failed (${res.status}): ${err.slice(0, 200)}`;
  }

  const data = (await res.json()) as {
    id: string;
    name: string;
    webViewLink: string;
    size?: string;
  };

  const size = data.size ? formatSize(Number(data.size)) : "unknown size";
  return `Uploaded "${data.name}" (${size})\nID: ${data.id}\nLink: ${data.webViewLink}`;
}

// ── Get File ────────────────────────────────────────────────────

const TEXT_MIME_PREFIXES = [
  "text/",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
];
const MAX_INLINE_SIZE = 32 * 1024;

export async function execGetDriveFile(fileId: string): Promise<string> {
  const rootId = getRootFolderId();
  const inside = await isInsideRoot(fileId, rootId);
  if (!inside) {
    return `ERROR: File ${fileId} is not inside the configured root Drive folder. Access denied.`;
  }

  const res = await googleFetch(
    `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,modifiedTime,webViewLink,webContentLink`,
  );

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    return `ERROR: Drive get failed (${res.status}): ${err.slice(0, 200)}`;
  }

  const data = (await res.json()) as {
    id: string;
    name: string;
    mimeType: string;
    size?: string;
    modifiedTime?: string;
    webViewLink?: string;
    webContentLink?: string;
  };

  const size = data.size ? formatSize(Number(data.size)) : "—";
  const modified = data.modifiedTime
    ? new Date(data.modifiedTime).toLocaleString()
    : "—";

  const lines = [
    `Name: ${data.name}`,
    `Type: ${data.mimeType}`,
    `Size: ${size}`,
    `Modified: ${modified}`,
    `ID: ${data.id}`,
    `View link: ${data.webViewLink ?? "—"}`,
    `Download link: ${data.webContentLink ?? "—"}`,
  ];

  // Inline content for small text-like files
  const isTextLike = TEXT_MIME_PREFIXES.some(
    (prefix) => data.mimeType.startsWith(prefix),
  );
  const fileSize = data.size ? Number(data.size) : Infinity;

  if (isTextLike && fileSize <= MAX_INLINE_SIZE) {
    const contentRes = await googleFetch(
      `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
    );
    if (contentRes.ok) {
      const content = await contentRes.text();
      lines.push("", "── Content ──", content);
    }
  }

  return lines.join("\n");
}

// ── Update File ─────────────────────────────────────────────────

export async function execUpdateDriveFile(
  fileId: string,
  contentBase64: string,
  mimeType?: string,
): Promise<string> {
  const rootId = getRootFolderId();
  const inside = await isInsideRoot(fileId, rootId);
  if (!inside) {
    return `ERROR: File ${fileId} is not inside the configured root Drive folder. Access denied.`;
  }

  // Fetch current metadata for name and mime fallback
  const metaRes = await googleFetch(
    `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?fields=name,mimeType`,
  );
  if (!metaRes.ok) {
    const err = await metaRes.text().catch(() => "");
    return `ERROR: Drive get metadata failed (${metaRes.status}): ${err.slice(0, 200)}`;
  }

  const meta = (await metaRes.json()) as { name: string; mimeType: string };
  const resolvedMime = mimeType ?? meta.mimeType;

  const boundary = "chomp_drive_boundary";
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify({}),
    `--${boundary}`,
    `Content-Type: ${resolvedMime}`,
    "Content-Transfer-Encoding: base64",
    "",
    contentBase64,
    `--${boundary}--`,
  ].join("\r\n");

  const res = await googleFetch(
    `${UPLOAD_BASE}/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id,name,size,modifiedTime`,
    {
      method: "PATCH",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
      timeoutMs: 120_000,
    },
  );

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    return `ERROR: Drive update failed (${res.status}): ${err.slice(0, 200)}`;
  }

  const data = (await res.json()) as {
    id: string;
    name: string;
    size?: string;
    modifiedTime?: string;
  };

  const size = data.size ? formatSize(Number(data.size)) : "unknown size";
  return `Updated "${data.name}" (${size})\nID: ${data.id}`;
}

// ── Delete File ─────────────────────────────────────────────────

export async function execDeleteDriveFile(fileId: string): Promise<string> {
  const rootId = getRootFolderId();

  if (fileId === rootId) {
    return "ERROR: Cannot delete the root Drive folder.";
  }

  const inside = await isInsideRoot(fileId, rootId);
  if (!inside) {
    return `ERROR: File ${fileId} is not inside the configured root Drive folder. Access denied.`;
  }

  // Fetch file name before deleting
  const metaRes = await googleFetch(
    `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?fields=name`,
  );
  if (!metaRes.ok) {
    const err = await metaRes.text().catch(() => "");
    return `ERROR: Drive get metadata failed (${metaRes.status}): ${err.slice(0, 200)}`;
  }

  const meta = (await metaRes.json()) as { name: string };

  const res = await googleFetch(
    `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}`,
    { method: "DELETE" },
  );

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    return `ERROR: Drive delete failed (${res.status}): ${err.slice(0, 200)}`;
  }

  return `Deleted "${meta.name}" (ID: ${fileId})`;
}

// ── Create Folder ───────────────────────────────────────────────

export async function execCreateDriveFolder(
  name: string,
  folderId?: string,
): Promise<string> {
  const folder = await resolveFolder(folderId);
  if (folder.error) return `ERROR: ${folder.error}`;

  const res = await googleFetch(
    `${DRIVE_BASE}/files?fields=id,name,webViewLink`,
    {
      method: "POST",
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [folder.id],
      }),
    },
  );

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    return `ERROR: Drive create folder failed (${res.status}): ${err.slice(0, 200)}`;
  }

  const data = (await res.json()) as {
    id: string;
    name: string;
    webViewLink: string;
  };

  return `Created folder "${data.name}"\nID: ${data.id}\nLink: ${data.webViewLink}`;
}
