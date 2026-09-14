import { readFile, writeFile } from 'node:fs/promises';
import { sign } from 'node:crypto';

const [archivePath, signaturePath, signingKeyPath] = process.argv.slice(2);
if (!archivePath || !signaturePath || !signingKeyPath) {
  throw new Error('Usage: node sign-catalog-release.mjs <zip> <signature> <private-key-pem>');
}

const [archive, privateKey] = await Promise.all([readFile(archivePath), readFile(signingKeyPath)]);
const signature = sign(null, archive, privateKey).toString('hex');
await writeFile(signaturePath, `${signature}\n`, { encoding: 'utf8', mode: 0o600 });
