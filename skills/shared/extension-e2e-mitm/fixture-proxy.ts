/*
@ai-invariant Fixture serving happens at the network layer — a local CONNECT proxy MITMs the allowlisted hosts.
<MODULE_CONTRACT>
<purpose>Starts a minimal CONNECT proxy on 127.0.0.1 that answers TLS for the allowlisted hosts with a per-run self-signed cert and serves the current fixture HTML for every request. Extension-spawned tab navigations bypass Playwright's route interception — the proxy intercepts them at the network layer instead.</purpose>
<non-goals>
  <item>Does not tunnel or forward real traffic — non-allowlisted CONNECTs are refused; the backend bypasses the proxy via --proxy-bypass-list.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Ported from dater RFC-0015 — parameterized host allowlist and cert SANs.</item>
</CHANGE_SUMMARY>
*/

import { createServer, type Server } from "node:net";
import { TLSSocket, createSecureContext } from "node:tls";
import { execFileSync } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface FixtureProxy {
  port: number;
  /** Base64 SHA-256 of the leaf cert's SPKI — for --ignore-certificate-errors-spki-list. */
  spkiFingerprint: string;
  /** Swap the HTML served for every intercepted request. */
  setContent(html: string): void;
  close(): void;
}

export interface FixtureProxyOptions {
  /** Host suffixes the proxy may MITM — e.g. ["example.com"] also covers sub.example.com. */
  hosts: string[];
}

function generateCert(dir: string, hosts: string[]): { key: Buffer; cert: Buffer } {
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  const primary = hosts[0];
  if (!primary) throw new Error("fixture proxy needs at least one host");
  const san = hosts.flatMap((h) => [`DNS:${h}`, `DNS:*.${h}`]).join(",");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath,
    "-out", certPath,
    "-days", "1",
    "-subj", `/CN=*.${primary}`,
    "-addext", `subjectAltName=${san}`,
  ]);
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

/** Base64 SHA-256 of the cert's SubjectPublicKeyInfo — Chromium's spki-list format. */
function spkiFingerprintOf(cert: Buffer): string {
  const spki = new X509Certificate(cert).publicKey.export({ format: "der", type: "spki" });
  return createHash("sha256").update(spki).digest("base64");
}

/**
 * Start a CONNECT proxy that MITMs the allowlisted hosts. Launch the browser
 * with --proxy-server pointing here, --proxy-bypass-list for the local
 * backend, and --ignore-certificate-errors-spki-list scoped to
 * proxy.spkiFingerprint.
 */
export async function startFixtureProxy(options: FixtureProxyOptions): Promise<FixtureProxy> {
  const dir = mkdtempSync(join(tmpdir(), "e2e-fixture-cert-"));
  const { key, cert } = generateCert(dir, options.hosts);
  const secureContext = createSecureContext({ key, cert });
  const spkiFingerprint = spkiFingerprintOf(cert);
  let content = "<html><body>no fixture installed</body></html>";

  const server: Server = createServer((sock) => {
    sock.once("data", (head) => {
      const line = head.toString("utf8").split("\r\n")[0] ?? "";
      const m = line.match(/^CONNECT ([^:]+):(\d+)/);
      if (!m) {
        sock.destroy();
        return;
      }
      const host = m[1]!;
      if (!options.hosts.some((s) => host === s || host.endsWith(`.${s}`))) {
        sock.destroy();
        return;
      }
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const tls = new TLSSocket(sock, { secureContext, isServer: true });
      tls.once("secure", () => {
        tls.once("data", () => {
          const body = content;
          tls.end(
            `HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
          );
        });
      });
      tls.on("error", () => sock.destroy());
    });
    sock.on("error", () => sock.destroy());
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as { port: number }).port;

  return {
    port,
    spkiFingerprint,
    setContent(html: string) {
      content = html;
    },
    close() {
      server.close();
    },
  };
}
