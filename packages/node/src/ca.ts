import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import forge from "node-forge";

const CA_DIR = join(process.cwd(), ".llmpeek", "ca");
export const CA_CERT_PATH = join(CA_DIR, "ca.pem");
const CA_KEY_PATH = join(CA_DIR, "ca-key.pem");

export interface CA {
  certPem: string;
  cert: forge.pki.Certificate;
  key: forge.pki.rsa.PrivateKey;
}

const CA_ATTRS = [
  { name: "commonName", value: "LLMPeek Local CA" },
  { name: "organizationName", value: "LLMPeek" },
];

/** Load the local CA, generating a fresh self-signed one (stored in .llmpeek/ca)
 *  the first time. The private key is written 0600 and never leaves the machine. */
export async function ensureCA(): Promise<CA> {
  if (existsSync(CA_CERT_PATH) && existsSync(CA_KEY_PATH)) {
    const certPem = await readFile(CA_CERT_PATH, "utf8");
    const keyPem = await readFile(CA_KEY_PATH, "utf8");
    return {
      certPem,
      cert: forge.pki.certificateFromPem(certPem),
      key: forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey,
    };
  }
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = `01${Date.now().toString(16)}`;
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 5);
  cert.setSubject(CA_ATTRS);
  cert.setIssuer(CA_ATTRS);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  await mkdir(CA_DIR, { recursive: true });
  await writeFile(CA_CERT_PATH, certPem);
  await writeFile(CA_KEY_PATH, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
  return { certPem, cert, key: keys.privateKey };
}

// One leaf keypair reused across all host certs — avoids a slow per-host RSA
// keygen; only the (fast) certificate differs per hostname.
let leaf: forge.pki.rsa.KeyPair | null = null;
const leafCertCache = new Map<string, { key: string; cert: string }>();

/** A leaf cert for `host`, signed by the local CA (cached per host). */
export function certForHost(ca: CA, host: string): { key: string; cert: string } {
  const cached = leafCertCache.get(host);
  if (cached) return cached;
  if (!leaf) leaf = forge.pki.rsa.generateKeyPair({ bits: 2048 });

  const cert = forge.pki.createCertificate();
  cert.publicKey = leaf.publicKey;
  cert.serialNumber = `${Date.now().toString(16)}${Math.floor(Math.random() * 1e6).toString(16)}`;
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);
  cert.setSubject([{ name: "commonName", value: host }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: host }] },
    // SKI + AKI are required by stricter verifiers (macOS / Python ssl reject a
    // leaf "Missing Authority Key Identifier" without them).
    { name: "subjectKeyIdentifier" },
    {
      name: "authorityKeyIdentifier",
      keyIdentifier: ca.cert.generateSubjectKeyIdentifier().getBytes(),
      authorityCertIssuer: true,
      serialNumber: ca.cert.serialNumber,
    },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());

  const out = {
    key: forge.pki.privateKeyToPem(leaf.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
  leafCertCache.set(host, out);
  return out;
}
