import { Buffer } from 'node:buffer';

// The deployed agent accepts one file per /run. Use a standard uncompressed
// POSIX tar for multiple files, avoiding a backend restart or lossy text tags.
// Only safe, unique basenames enter the archive; original names remain in task.
export function packAttachments(files) {
  if (!files.length) return {};
  if (files.length === 1) return {
    fileBase64: files[0].base64, fileName: files[0].name, fileMimeType: files[0].mime,
  };
  const blocks = [];
  for (const file of files) {
    const bytes = Buffer.from(file.base64, 'base64');
    const header = Buffer.alloc(512);
    const name = `${file.index}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`.slice(0, 99);
    const octal = (value, offset, width) => header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width, 'ascii');
    header.write(name, 0, 100, 'ascii');
    octal(0o600, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(bytes.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const checksum = header.reduce((sum, b) => sum + b, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return { fileBase64: Buffer.concat(blocks).toString('base64'),
    fileName: `intake-${crypto.randomUUID()}.tar`, fileMimeType: 'application/x-tar' };
}
