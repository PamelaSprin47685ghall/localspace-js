import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

for (const flag of ["-v", "--version"]) {
  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", flag], {
    encoding: "utf8",
    env: { ...process.env, LOCALSPACE_CONFIG_DIR: "/tmp/localspace-cli-version-test" },
    windowsHide: true,
  }).trim();

  assert.equal(output, packageJson.version);
}

function newConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "localspace-cli-init-test-"));
}

interface CliRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: readonly string[], configDir: string): CliRunResult {
  const result = spawnSync("node", ["--import", "tsx", "src/cli.ts", ...args], {
    encoding: "utf8",
    env: { ...process.env, LOCALSPACE_CONFIG_DIR: configDir },
    windowsHide: true,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// Non-interactive init writes config and auth files from flags alone
{
  const configDir = newConfigDir();
  const rootsInput = `${join(configDir, "projects")},~/personal-projects`;
  const init = runCli(
    [
      "init",
      "--non-interactive",
      "--roots",
      rootsInput,
      "--port",
      "7788",
      "--public-base-url",
      "https://demo.example.com/",
    ],
    configDir,
  );

  assert.equal(init.status, 0, `init failed: ${init.stderr}`);
  const auth = JSON.parse(readFileSync(join(configDir, "auth.json"), "utf8")) as { ownerToken?: string };
  const config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")) as {
    host?: string;
    port?: number;
    allowedRoots?: string[];
    publicBaseUrl?: string | null;
  };

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 7788);
  assert.deepEqual(config.allowedRoots, [
    resolve(join(configDir, "projects")),
    resolve(join(homedir(), "personal-projects")),
  ]);
  assert.equal(config.publicBaseUrl, "https://demo.example.com");
  assert.ok(auth.ownerToken && auth.ownerToken.length >= 40);
  assert.ok(init.stdout.includes(`Owner password: ${auth.ownerToken}`));
}

// A second non-interactive init without --force keeps existing files untouched
{
  const configDir = newConfigDir();
  const firstArgs = [
    "init",
    "--non-interactive",
    "--roots",
    configDir,
    "--public-base-url",
    "https://first.example.com",
  ];
  assert.equal(runCli(firstArgs, configDir).status, 0);

  const before = readFileSync(join(configDir, "config.json"), "utf8");
  const rerun = runCli(firstArgs, configDir);
  assert.equal(rerun.status, 0);
  assert.match(rerun.stdout, /already configured/);
  assert.equal(readFileSync(join(configDir, "config.json"), "utf8"), before);

  // --force overwrites while preserving the existing Owner password
  const forced = runCli([...firstArgs, "--force", "--port", "7799"], configDir);
  assert.equal(forced.status, 0);
  const afterForce = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")) as { port?: number };
  const authAfterForce = JSON.parse(readFileSync(join(configDir, "auth.json"), "utf8")) as {
    ownerToken?: string;
  };
  assert.equal(afterForce.port, 7799);
  assert.ok(authAfterForce.ownerToken && authAfterForce.ownerToken.length >= 40);
}

// Non-interactive init rejects invalid inputs with a nonzero exit code
{
  const configDir = newConfigDir();
  const invalidRuns: ReadonlyArray<readonly string[]> = [
    ["init", "--non-interactive"],
    ["init", "--non-interactive", "--roots", ""],
    ["init", "--non-interactive", "--roots", "x", "--port", "99999"],
    ["init", "--non-interactive", "--roots", "x", "--public-base-url", "https://host.example.com/mcp"],
    ["init", "--non-interactive", "--unexpected-flag"],
  ];

  for (const args of invalidRuns) {
    const result = runCli(args, configDir);
    assert.notEqual(result.status, 0, `expected failure for: ${args.join(" ")}`);
    assert.ok(result.stderr.trim().length > 0, `expected an error message for: ${args.join(" ")}`);
  }
}

// Local-only non-interactive init omits the public URL and the core derives it
{
  const configDir = newConfigDir();
  const init = runCli(
    ["init", "--non-interactive", "--roots", configDir, "--port", "7688"],
    configDir,
  );

  assert.equal(init.status, 0, `init failed: ${init.stderr}`);
  assert.match(init.stdout, /Public MCP URL: not configured/);
  const config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")) as {
    publicBaseUrl?: string | null;
  };
  assert.equal(config.publicBaseUrl ?? null, null);

  const doctor = runCli(["doctor", "--json"], configDir);
  assert.equal(doctor.status, 0);
  const report = JSON.parse(doctor.stdout) as {
    server?: { publicMcpUrl?: string; localMcpUrl?: string };
  };
  assert.equal(report.server?.localMcpUrl, "http://127.0.0.1:7688/mcp");
  assert.equal(report.server?.publicMcpUrl, "http://127.0.0.1:7688/mcp");
}

// doctor --json prints a machine-readable report and still supports text mode
{
  const configDir = newConfigDir();
  assert.equal(
    runCli(
      [
        "init",
        "--non-interactive",
        "--roots",
        configDir,
        "--public-base-url",
        "https://doctor.example.com",
      ],
      configDir,
    ).status,
    0,
  );

  const jsonRun = runCli(["doctor", "--json"], configDir);
  assert.equal(jsonRun.status, 0);
  const report = JSON.parse(jsonRun.stdout) as {
    configDir?: string;
    runtime?: { nodeSupported?: boolean; supportedRange?: string };
    sqliteNative?: { ok?: boolean };
    server?: { localMcpUrl?: string; publicMcpUrl?: string };
  };
  assert.equal(report.configDir, configDir);
  assert.equal(report.runtime?.nodeSupported, true);
  assert.equal(report.sqliteNative?.ok, true);
  assert.equal(report.server?.localMcpUrl, "http://127.0.0.1:7676/mcp");
  assert.equal(report.server?.publicMcpUrl, "https://doctor.example.com/mcp");

  const textRun = runCli(["doctor"], configDir);
  assert.equal(textRun.status, 0);
  assert.match(textRun.stdout, /^Config dir: /m);
  assert.match(textRun.stdout, /SQLite native dependency: ok/m);

  // An unconfigured directory reports the error instead of throwing
  const brokenRun = runCli(["doctor", "--json"], newConfigDir());
  assert.equal(brokenRun.status, 0);
  const brokenReport = JSON.parse(brokenRun.stdout) as { configError?: string; server?: unknown };
  assert.ok(brokenReport.configError);
  assert.equal(brokenReport.server, undefined);
}
