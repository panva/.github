const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const workspace = process.env.GITHUB_WORKSPACE || process.cwd();

function input(name) {
  return process.env[`INPUT_${name.toUpperCase()}`] || "";
}

function manifest(directory = workspace) {
  return JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
}

function sourceManifest() {
  return manifest(path.resolve(workspace, input("manifest_directory") || "."));
}

function releaseVersion() {
  const pkg = sourceManifest();
  const expected = `v${pkg.version}`;
  if (
    input("require_tag") !== "false" &&
    (process.env.GITHUB_REF_TYPE !== "tag" ||
      process.env.GITHUB_REF_NAME !== expected)
  ) {
    throw new Error(
      `release tag ${process.env.GITHUB_REF_NAME || "(none)"} does not match ${pkg.name}@${pkg.version}`,
    );
  }
  return pkg;
}

function cleanupPaths() {
  const entries = JSON.parse(input("cleanup_paths") || "[]");
  if (!Array.isArray(entries)) {
    throw new TypeError("cleanup_paths must be a JSON array");
  }
  for (const entry of entries) {
    if (
      typeof entry !== "string" ||
      entry === "" ||
      entry === "." ||
      path.isAbsolute(entry) ||
      entry.split(/[\\/]/).includes("..") ||
      !/^[\w./-]+$/.test(entry)
    ) {
      throw new TypeError(`unsafe cleanup path: ${JSON.stringify(entry)}`);
    }
  }
  return entries;
}

function preflight() {
  const pkg = verifyRemoteTag();
  const paths = cleanupPaths();
  for (const relative of paths) {
    if (!existsSync(path.resolve(workspace, relative))) {
      throw new Error(
        `cleanup path does not exist in the release: ${relative}`,
      );
    }
  }

  if (input("require_tag") !== "false") {
    if (
      input("maintenance_branch") === "true" &&
      !/^v\d+\.\d+\.\d+$/.test(process.env.GITHUB_REF_NAME)
    ) {
      throw new Error(`unexpected release tag: ${process.env.GITHUB_REF_NAME}`);
    }
    if (input("github_release") === "true") {
      const changelog = path.resolve(
        workspace,
        input("changelog_path") || "CHANGELOG.md",
      );
      extractReleaseNotes(readFileSync(changelog, "utf8"), pkg.version);
    }
  }

  if (input("publish_jsr") === "true") {
    const jsr = JSON.parse(
      readFileSync(path.join(workspace, "jsr.json"), "utf8"),
    );
    if (jsr.version !== pkg.version) {
      throw new Error(
        `jsr.json version ${jsr.version} does not match package.json version ${pkg.version}`,
      );
    }
  }

  console.log(`validated release configuration for ${pkg.name}@${pkg.version}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || workspace,
    encoding: options.encoding,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? `: ${(result.stderr || "").trim()}` : "";
    throw new Error(`${command} exited with status ${result.status}${detail}`);
  }
  return result;
}

function git(args, options) {
  return run("git", args, options);
}

function isAncestor(ancestor, descendant) {
  const result = git(["merge-base", "--is-ancestor", ancestor, descendant], {
    allowFailure: true,
  });
  if (result.status > 1) {
    throw new Error(`could not compare ${ancestor} with ${descendant}`);
  }
  return result.status === 0;
}

function objectExists(ref, relative) {
  return (
    git(["cat-file", "-e", `${ref}:${relative}`], {
      allowFailure: true,
      capture: true,
    }).status === 0
  );
}

function push(refspec) {
  return git(["push", "origin", refspec], { allowFailure: true }).status === 0;
}

function commit(ref) {
  return git(["rev-parse", `${ref}^{commit}`], {
    capture: true,
    encoding: "utf8",
  }).stdout.trim();
}

function verifyRemoteTag() {
  const pkg = releaseVersion();
  if (input("require_tag") === "false") {
    return pkg;
  }

  const tag = process.env.GITHUB_REF_NAME;
  const local = commit(process.env.GITHUB_SHA);
  const remote = git(
    ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    { capture: true, encoding: "utf8" },
  )
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  const peeled = remote.find((line) => line.endsWith("^{}"));
  const target = (peeled || remote[0] || "").split(/\s/)[0];
  if (target !== local) {
    throw new Error(
      `remote tag ${tag} no longer identifies the triggering commit`,
    );
  }
  return pkg;
}

function verifyTag() {
  const pkg = verifyRemoteTag();
  console.log(
    `verified ${process.env.GITHUB_REF_NAME} for ${pkg.name}@${pkg.version}`,
  );
}

function validate() {
  const tarball = path.resolve(workspace, input("tarball"));
  const source = releaseVersion();
  const staging = mkdtempSync(path.join(tmpdir(), "panva-npm-release-"));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";

  try {
    writeFileSync(
      path.join(staging, "package.json"),
      JSON.stringify({
        name: "release-artifact-validation",
        private: true,
        type: "module",
      }),
    );
    run(
      npm,
      [
        "install",
        "--install-strategy=nested",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        tarball,
      ],
      { cwd: staging },
    );

    const installed = path.join(
      staging,
      "node_modules",
      ...source.name.split("/"),
    );
    const packed = manifest(installed);
    if (packed.name !== source.name || packed.version !== source.version) {
      throw new Error(
        "the package tarball does not match the checked-out package name and version",
      );
    }
    let specifiers = [source.name];
    if (
      packed.exports !== null &&
      typeof packed.exports === "object" &&
      Object.keys(packed.exports).some((key) => key.startsWith("."))
    ) {
      specifiers = Object.entries(packed.exports)
        .filter(
          ([key, value]) =>
            value !== null &&
            key.startsWith(".") &&
            !key.includes("*") &&
            key !== "./package.json",
        )
        .map(([key]) =>
          key === "." ? source.name : source.name + key.slice(1),
        );
    }
    writeFileSync(
      path.join(staging, "smoke.mjs"),
      `for (const specifier of ${JSON.stringify(specifiers)}) await import(specifier)\n`,
    );
    run(process.execPath, ["smoke.mjs"], { cwd: staging });
    console.log(
      `validated ${path.basename(tarball)} as ${packed.name}@${packed.version}`,
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const MAX_WAIT = 60 * 60_000;
const RETRY_INTERVAL = 60_000;
const REQUEST_TIMEOUT = 15_000;

function registryUrl(pkg) {
  return `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`;
}

async function stagePackage() {
  const pkg = verifyRemoteTag();
  const tarball = path.resolve(workspace, input("tarball"));
  const expectedIntegrity = `sha512-${createHash("sha512")
    .update(readFileSync(tarball))
    .digest("base64")}`;
  const response = await fetch(registryUrl(pkg), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });

  if (response.ok) {
    const published = await response.json();
    if (
      published.version !== pkg.version ||
      published.dist?.integrity !== expectedIntegrity
    ) {
      throw new Error(
        `${pkg.name}@${pkg.version} is already published with a different package artifact`,
      );
    }
    console.log(
      `${pkg.name}@${pkg.version} is already published with the exact package artifact`,
    );
    return;
  }
  if (response.status !== 404) {
    throw new Error(
      `npm registry returned ${response.status} ${response.statusText}`,
    );
  }

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  run(npm, ["stage", "publish", tarball]);
}

async function waitForNpm() {
  const pkg = releaseVersion();
  const deadline = Date.now() + MAX_WAIT;

  for (;;) {
    let reason = "is not published yet";
    try {
      const response = await fetch(registryUrl(pkg), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
      if (response.ok && (await response.json()).version === pkg.version) {
        console.log(`${pkg.name}@${pkg.version} is available on npm`);
        return;
      }
      if (response.status !== 404) {
        reason = `could not be checked: npm registry returned ${response.status} ${response.statusText}`;
      }
    } catch (error) {
      reason = `could not be checked: ${error.message}`;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `${pkg.name}@${pkg.version} was not published within 60 minutes`,
      );
    }
    console.log(`${pkg.name}@${pkg.version} ${reason}, retrying in one minute`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL));
  }
}

function configureGit() {
  git(["config", "--local", "user.name", "github-actions[bot]"]);
  git([
    "config",
    "--local",
    "user.email",
    "41898282+github-actions[bot]@users.noreply.github.com",
  ]);
  git(["config", "--local", "commit.gpgsign", "false"]);
}

function verifyIntegrated(releaseSha, cleanupPaths, mainBranch) {
  git(["fetch", "origin", mainBranch]);
  if (!isAncestor(releaseSha, "FETCH_HEAD")) {
    return false;
  }
  return cleanupPaths.every(
    (relative) => !objectExists("FETCH_HEAD", relative),
  );
}

function integrate() {
  verifyRemoteTag();
  const releaseSha = commit(process.env.GITHUB_SHA);
  const mainBranch = input("main_branch") || "main";
  const paths = cleanupPaths();

  configureGit();
  git(["fetch", "origin", mainBranch]);
  let mainReady = false;

  if (isAncestor(releaseSha, "FETCH_HEAD")) {
    if (paths.every((relative) => !objectExists("FETCH_HEAD", relative))) {
      console.log(
        `${mainBranch} already contains ${process.env.GITHUB_REF_NAME} and is clean`,
      );
      mainReady = true;
    } else {
      git(["checkout", "--detach", "FETCH_HEAD"]);
    }
  } else {
    git(["checkout", "--detach", "FETCH_HEAD"]);
    git([
      "merge",
      paths.length === 0 ? "--no-edit" : "--no-commit",
      releaseSha,
    ]);
  }

  if (!mainReady) {
    if (paths.length !== 0) {
      git(["rm", "-r", "-f", "--ignore-unmatch", "--", ...paths]);
      git(["commit", "-m", "chore: cleanup after release"]);
    }
    if (!push(`HEAD:refs/heads/${mainBranch}`)) {
      if (!verifyIntegrated(releaseSha, paths, mainBranch)) {
        throw new Error(
          `could not integrate ${process.env.GITHUB_REF_NAME} into ${mainBranch}`,
        );
      }
    }
  }

  if (input("maintenance_branch") !== "true") {
    return;
  }
  const match = /^v(\d+)\.\d+\.\d+$/.exec(process.env.GITHUB_REF_NAME);
  if (match === null) {
    throw new Error(`unexpected release tag: ${process.env.GITHUB_REF_NAME}`);
  }
  if (match[1] === "0") {
    console.log("0.x is not maintained on a release branch, skipping");
    return;
  }
  const branch = `v${match[1]}.x`;
  if (!push(`${releaseSha}:refs/heads/${branch}`)) {
    git(["fetch", "origin", branch]);
    if (!isAncestor(releaseSha, "FETCH_HEAD")) {
      throw new Error(`could not update ${branch}`);
    }
  }
}

function extractReleaseNotes(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^## \\[?${escaped}(?:\\]|\\s)`, "m");
  const match = heading.exec(changelog);
  if (match === null) {
    throw new Error(
      `could not find a "## ${version}" heading in the changelog`,
    );
  }
  const notesStart = changelog.indexOf("\n", match.index) + 1;
  const nextRelease = /^## \[?\d+\.\d+\.\d+/m.exec(changelog.slice(notesStart));
  return (
    nextRelease === null
      ? changelog.slice(notesStart)
      : changelog.slice(notesStart, notesStart + nextRelease.index)
  ).trim();
}

function gh(args, options = {}) {
  return run("gh", args, options);
}

function digest(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function publishedAssetMatches(tag, asset) {
  const staging = mkdtempSync(path.join(tmpdir(), "panva-release-asset-"));
  const downloaded = path.join(staging, path.basename(asset));
  try {
    gh([
      "release",
      "download",
      tag,
      "--pattern",
      path.basename(asset),
      "--output",
      downloaded,
    ]);
    return digest(downloaded) === digest(asset);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function githubRelease() {
  const pkg = verifyRemoteTag();
  const tag = process.env.GITHUB_REF_NAME;
  const changelog = path.resolve(
    workspace,
    input("changelog_path") || "CHANGELOG.md",
  );
  const assetDirectory = path.resolve(workspace, input("asset_directory"));
  const assets = readdirSync(assetDirectory)
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => path.join(assetDirectory, entry));
  if (assets.length !== 1) {
    throw new Error(`expected one package tarball, found ${assets.length}`);
  }

  const notes = extractReleaseNotes(
    readFileSync(changelog, "utf8"),
    pkg.version,
  );
  const notesPath = path.join(tmpdir(), `release-notes-${process.pid}.md`);
  writeFileSync(notesPath, notes);

  try {
    let release;
    const viewed = gh(["release", "view", tag, "--json", "assets,isDraft"], {
      allowFailure: true,
      capture: true,
      encoding: "utf8",
    });
    if (viewed.status === 0) {
      release = JSON.parse(viewed.stdout);
    }

    if (release !== undefined && !release.isDraft) {
      const asset = assets[0];
      if (!release.assets.some(({ name }) => name === path.basename(asset))) {
        throw new Error(
          `${tag} is already published but is missing its package artifact`,
        );
      }
      if (!publishedAssetMatches(tag, asset)) {
        throw new Error(
          `${tag} is already published with a different package artifact`,
        );
      }
      console.log(`${tag} is already published with its package artifact`);
      return;
    }

    if (release === undefined) {
      gh([
        "release",
        "create",
        tag,
        "--draft",
        "--verify-tag",
        "-F",
        notesPath,
        "--title",
        tag,
      ]);
    }
    gh(["release", "upload", tag, ...assets, "--clobber"]);
    gh([
      "release",
      "edit",
      tag,
      "--draft=false",
      "--verify-tag",
      "-F",
      notesPath,
      "--title",
      tag,
      "--discussion-category",
      "Releases",
    ]);
  } finally {
    rmSync(notesPath, { force: true });
  }
}

const operations = {
  preflight,
  validate,
  "verify-tag": verifyTag,
  stage: stagePackage,
  wait: waitForNpm,
  integrate,
  "github-release": githubRelease,
};

const operation = operations[input("operation")];
if (operation === undefined) {
  throw new Error(`unknown npm release operation: ${input("operation")}`);
}

Promise.resolve()
  .then(operation)
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
