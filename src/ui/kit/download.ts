// Browser file downloads (CSV exports, JSON backups): a Blob behind a temporary hidden <a download>.

/** Download `parts` as `file`; returns the file name. */
export function downloadBlob(file: string, parts: BlobPart[], type: string): string {
  const url = URL.createObjectURL(new Blob(parts, { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return file;
}

/** Download JSON text as `file`; returns the file name. */
export const downloadJson = (file: string, json: string): string => downloadBlob(file, [json], 'application/json');
