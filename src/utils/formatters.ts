export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(2)} KB (${bytes.toLocaleString()} B)`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

export function formatShortBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(2)} KB`;
}

export function formatHexPreview(bytes: Uint8Array, maxBytes = 64): string {
  const slice = bytes.subarray(0, maxBytes);
  const hexParts: string[] = [];
  for (let i = 0; i < slice.length; i++) {
    hexParts.push(slice[i].toString(16).toUpperCase().padStart(2, '0'));
  }
  const suffix = bytes.length > maxBytes ? ` … (+${bytes.length - maxBytes} more bytes)` : '';
  return hexParts.join(' ') + suffix;
}

export function formatBinaryPreview(bytes: Uint8Array, maxBytes = 16): string {
  const slice = bytes.subarray(0, maxBytes);
  const binParts: string[] = [];
  for (let i = 0; i < slice.length; i++) {
    binParts.push(slice[i].toString(2).padStart(8, '0'));
  }
  const suffix = bytes.length > maxBytes ? ` …` : '';
  return binParts.join(' ') + suffix;
}

export function downloadBinaryFile(bytes: Uint8Array, filename: string): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadTextFile(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

