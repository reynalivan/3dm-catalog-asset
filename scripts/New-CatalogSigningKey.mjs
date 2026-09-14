import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keyDirectory = path.join(root, '.keys');
const privateKeyPath = path.join(keyDirectory, 'catalog-update-ed25519.pem');
const publicKeyPath = path.join(keyDirectory, 'catalog-update-ed25519.public.pem');

try {
  await access(privateKeyPath, constants.F_OK);
  throw new Error(`A signing key already exists at ${privateKeyPath}. Refusing to replace it.`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

await mkdir(keyDirectory, { recursive: true });
const pair = generateKeyPairSync('ed25519');
const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
await writeFile(privateKeyPath, privateKey, { encoding: 'utf8', mode: 0o600 });
await writeFile(publicKeyPath, publicKey, { encoding: 'utf8', mode: 0o644 });

const publicDer = createPublicKey(await readFile(publicKeyPath)).export({ type: 'spki', format: 'der' });
console.log(publicDer.subarray(-32).toString('hex'));
