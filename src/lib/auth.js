// PBKDF2 password verification — must match params in user-mgmt.js hashPassword()
export async function verifyPassword(password, storedHash, storedSalt) {
  const enc = new TextEncoder();
  const salt = new Uint8Array(storedSalt.match(/.{2}/g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 },
    key, 256
  );
  const hashHex = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex === storedHash;
}
