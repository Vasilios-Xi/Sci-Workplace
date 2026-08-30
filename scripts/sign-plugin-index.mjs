import { readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

const [indexPath, privateKeyPath, outputPath, keyId] = process.argv.slice(2);
if (!indexPath || !privateKeyPath || !outputPath || !keyId) {
  throw new Error('Usage: node scripts/sign-plugin-index.mjs <index.json> <ed25519-private.pem> <signed.json> <key-id>');
}
const index = JSON.parse(readFileSync(indexPath, 'utf8'));
if (index.schemaVersion !== 1) throw new Error('Only curated plugin index schemaVersion 1 can be signed');
const privateKeySource = privateKeyPath.startsWith('env:')
  ? process.env[privateKeyPath.slice(4)]
  : readFileSync(privateKeyPath, 'utf8');
if (!privateKeySource) throw new Error(`Ed25519 private key is unavailable: ${privateKeyPath}`);
const privateKey = createPrivateKey(privateKeySource.replaceAll('\\n', '\n'));
const payload = Buffer.from(canonicalJson(index), 'utf8');
const signatureBytes = sign(null, payload, privateKey);
if (!verify(null, payload, createPublicKey(privateKey), signatureBytes)) throw new Error('Ed25519 signing self-check failed');
const signature = signatureBytes.toString('base64');
writeFileSync(outputPath, `${JSON.stringify({ keyId, algorithm: 'Ed25519', index, signature }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
