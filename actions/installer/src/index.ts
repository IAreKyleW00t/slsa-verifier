// Copyright 2022 SLSA Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as github from "@actions/github";
import * as io from "@actions/io";
import * as tc from "@actions/tool-cache";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const BOOTSTRAP_VERSION = "v2.5.1-rc.0";
const BOOTSTRAP_VERIFIER_SHA256: { [key: string]: { [key: string]: string } } =
  {
    win32: {
      x64: "fd32c79eb0c004c134e5ee1dda6e88cb37c1f6b7eb04a4c744fb14999a94220f",
      arm64: "2e6cf234caa14c804176fe1552c80438f541b6527674210fc6d98dffb0dd1fd3",
    },
    linux: {
      x64: "ccd1edf540ceb9283688745069c041907e5f4cda9dd07a344e601cafb4d11dd2",
      arm64: "6dfa11545f3bbc0a7852b6afb3b493b2f19f5fea72188ca97cdd4f3618520983",
    },
    darwin: {
      x64: "2a8951b00be5ef8104945d05e4a3c64d2096028d2fc8c128eba025f851c0fe78",
      arm64: "aef9eb87a368c0e346e91cf273ab56644693250cbf3e318423de2fb06879334e",
    },
  };

// Generates the Release artifact name based on OS and architecture
export function getReleaseArtifactName(): string {
  const platform = process.platform.replace("win32", "windows");
  const arch = process.arch.replace("x64", "amd64");
  return `slsa-verifier-${platform}-${arch}${platform === "windows" ? ".exe" : ""}`;
}

// Generates the final binary name based on OS
export function getBinaryName(): string {
  return `slsa-verifier${process.platform === "win32" ? ".exe" : ""}`;
}

// If true, the input string conforms to slsa-verifier's versioning system.
export function validVersion(version: string): boolean {
  const re = /(v[0-9]+\.[0-9]+\.[0-9]+)/;
  return re.test(version);
}

// Resolve command line argument to a version number
export async function getVerifierVersion(actionRef: string): Promise<string> {
  if (validVersion(actionRef)) {
    return actionRef;
  }

  // If actionRef is a commit SHA, then find the associated version number.
  const shaRe = /^[a-f\d]{40}$/;
  if (shaRe.test(actionRef)) {
    const octokit = github.getOctokit(core.getInput("github-token"));
    const { data: tags } = await octokit.request(
      "GET /repos/{owner}/{repository}/tags",
      {
        owner: "slsa-framework",
        repository: "slsa-verifier",
      },
    );
    for (const tag of tags) {
      const commitSha = tag.commit.sha;
      if (commitSha === actionRef) {
        return tag.name;
      }
    }
  }
  throw new Error(
    `Invalid version provided: ${actionRef}. For the set of valid versions, see https://github.com/slsa-framework/slsa-verifier/releases.`,
  );
}

// If true, then the file in `path` has the same SHA256 hash as `expectedSha256Hash``.
export function fileHasExpectedSha256Hash(
  filePath: string,
  expectedSha256Hash: string,
): boolean {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const untrustedFile = fs.readFileSync(filePath);
  const computedSha256Hash = crypto
    .createHash("sha256")
    .update(untrustedFile)
    .digest("hex");
  return computedSha256Hash === expectedSha256Hash;
}

let tmpDir: string;

// Delete bootstrap version and maybe installed version
async function cleanup(): Promise<void> {
  await io.rmRF(`${tmpDir}`);
}

async function run(): Promise<void> {
  // Get requested verifier version and validate
  // SLSA_VERIFIER_CI_ACTION_REF is a utility env variable to help us test
  // the Action in CI.
  const actionRef =
    process.env.SLSA_VERIFIER_CI_ACTION_REF ||
    process.env.GITHUB_ACTION_REF ||
    "";
  let version: string;
  try {
    version = await getVerifierVersion(actionRef);
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    core.setFailed(
      `Invalid version provided. For the set of valid versions, see https://github.com/slsa-framework/slsa-verifier/releases. ${errMsg}`,
    );
    cleanup();
    return;
  }

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slsa-verifier_"));
  const bootstrapDir = `${tmpDir}/bootstrap`;
  const installDir = `${tmpDir}/${version}`;
  const artifactName = getReleaseArtifactName();
  const binaryName = getBinaryName();

  let bootstrapVerifierPath;
  try {
    // Download bootstrap version and validate SHA256 checksum
    bootstrapVerifierPath = await tc.downloadTool(
      `https://github.com/slsa-framework/slsa-verifier/releases/download/${BOOTSTRAP_VERSION}/${artifactName}`,
      path.join(bootstrapDir, binaryName),
    );
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    core.setFailed(`Error downloading bootstrap slsa-verifier: ${errMsg}`);
    cleanup();
    return;
  }

  if (
    !fileHasExpectedSha256Hash(
      bootstrapVerifierPath,
      BOOTSTRAP_VERIFIER_SHA256[process.platform][process.arch],
    )
  ) {
    core.setFailed(
      `Unable to verify slsa-verifier checksum. Aborting installation.`,
    );
    cleanup();
    return;
  }

  fs.chmodSync(bootstrapVerifierPath, 0o100);

  let downloadedBinaryPath;
  try {
    // Download requested version binary and provenance
    downloadedBinaryPath = await tc.downloadTool(
      `https://github.com/slsa-framework/slsa-verifier/releases/download/${version}/${artifactName}`,
      path.join(installDir, binaryName),
    );
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    core.setFailed(`Error downloading slsa-verifier: ${errMsg}`);
    cleanup();
    return;
  }
  let downloadedProvenancePath;
  try {
    downloadedProvenancePath = await tc.downloadTool(
      `https://github.com/slsa-framework/slsa-verifier/releases/download/${version}/${artifactName}.intoto.jsonl`,
      path.join(installDir, `${artifactName}.intoto.jsonl`),
    );
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    core.setFailed(`Error downloading binary provenance: ${errMsg}`);
    cleanup();
    return;
  }

  // Validate binary provenance
  try {
    const { exitCode, stdout, stderr } = await exec.getExecOutput(
      `${bootstrapVerifierPath}`,
      [
        "verify-artifact",
        downloadedBinaryPath,
        "--provenance-path",
        downloadedProvenancePath,
        "--source-uri",
        "github.com/slsa-framework/slsa-verifier",
        "--source-tag",
        version,
      ],
    );
    if (exitCode !== 0) {
      throw new Error(
        `Unable to verify binary provenance. Aborting installation. stdout: ${stdout}; stderr: ${stderr}`,
      );
    }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    core.setFailed(`Error executing slsa-verifier: ${errMsg}`);
    cleanup();
    return;
  }

  // Copy requested version to HOME directory.
  const finalDir = path.join(os.homedir(), ".slsa", "bin", version);
  const finalPath = path.join(finalDir, binaryName);

  fs.mkdirSync(finalDir, { recursive: true });
  fs.copyFileSync(downloadedBinaryPath, finalPath);
  fs.chmodSync(finalPath, 0o100);
  core.addPath(finalDir);
  core.setOutput("verifier-path", finalDir);

  cleanup();
}

run();
