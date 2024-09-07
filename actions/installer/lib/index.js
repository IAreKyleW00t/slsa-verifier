'use strict'
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
var __createBinding =
  (this && this.__createBinding) ||
  (Object.create
    ? function (o, m, k, k2) {
        if (k2 === undefined) k2 = k
        var desc = Object.getOwnPropertyDescriptor(m, k)
        if (
          !desc ||
          ('get' in desc ? !m.__esModule : desc.writable || desc.configurable)
        ) {
          desc = {
            enumerable: true,
            get: function () {
              return m[k]
            }
          }
        }
        Object.defineProperty(o, k2, desc)
      }
    : function (o, m, k, k2) {
        if (k2 === undefined) k2 = k
        o[k2] = m[k]
      })
var __setModuleDefault =
  (this && this.__setModuleDefault) ||
  (Object.create
    ? function (o, v) {
        Object.defineProperty(o, 'default', { enumerable: true, value: v })
      }
    : function (o, v) {
        o['default'] = v
      })
var __importStar =
  (this && this.__importStar) ||
  function (mod) {
    if (mod && mod.__esModule) return mod
    var result = {}
    if (mod != null)
      for (var k in mod)
        if (k !== 'default' && Object.prototype.hasOwnProperty.call(mod, k))
          __createBinding(result, mod, k)
    __setModuleDefault(result, mod)
    return result
  }
var __awaiter =
  (this && this.__awaiter) ||
  function (thisArg, _arguments, P, generator) {
    function adopt(value) {
      return value instanceof P
        ? value
        : new P(function (resolve) {
            resolve(value)
          })
    }
    return new (P || (P = Promise))(function (resolve, reject) {
      function fulfilled(value) {
        try {
          step(generator.next(value))
        } catch (e) {
          reject(e)
        }
      }
      function rejected(value) {
        try {
          step(generator['throw'](value))
        } catch (e) {
          reject(e)
        }
      }
      function step(result) {
        result.done
          ? resolve(result.value)
          : adopt(result.value).then(fulfilled, rejected)
      }
      step((generator = generator.apply(thisArg, _arguments || [])).next())
    })
  }
Object.defineProperty(exports, '__esModule', { value: true })
exports.fileHasExpectedSha256Hash =
  exports.getVerifierVersion =
  exports.validVersion =
    void 0
const core = __importStar(require('@actions/core'))
const exec = __importStar(require('@actions/exec'))
const github = __importStar(require('@actions/github'))
const io = __importStar(require('@actions/io'))
const tc = __importStar(require('@actions/tool-cache'))
const crypto = __importStar(require('crypto'))
const fs = __importStar(require('fs'))
const os = __importStar(require('os'))
const path = __importStar(require('path'))
const BOOTSTRAP_VERSION = 'v2.5.1-rc.0'
const BOOTSTRAP_VERIFIER_SHA256 =
  'ccd1edf540ceb9283688745069c041907e5f4cda9dd07a344e601cafb4d11dd2'
const BINARY_NAME = 'slsa-verifier'
const PROVENANCE_NAME = 'slsa-verifier-linux-amd64.intoto.jsonl'
// If true, the input string conforms to slsa-verifier's versioning system.
function validVersion(version) {
  const re = /(v[0-9]+\.[0-9]+\.[0-9]+)/
  return re.test(version)
}
exports.validVersion = validVersion
// Resolve command line argument to a version number
function getVerifierVersion(actionRef) {
  return __awaiter(this, void 0, void 0, function* () {
    if (validVersion(actionRef)) {
      return actionRef
    }
    // If actionRef is a commit SHA, then find the associated version number.
    const shaRe = /^[a-f\d]{40}$/
    if (shaRe.test(actionRef)) {
      const octokit = github.getOctokit(core.getInput('github-token'))
      const { data: tags } = yield octokit.request(
        'GET /repos/{owner}/{repository}/tags',
        {
          owner: 'slsa-framework',
          repository: 'slsa-verifier'
        }
      )
      for (const tag of tags) {
        const commitSha = tag.commit.sha
        if (commitSha === actionRef) {
          return tag.name
        }
      }
    }
    throw new Error(
      `Invalid version provided: ${actionRef}. For the set of valid versions, see https://github.com/slsa-framework/slsa-verifier/releases.`
    )
  })
}
exports.getVerifierVersion = getVerifierVersion
// If true, then the file in `path` has the same SHA256 hash as `expectedSha256Hash``.
function fileHasExpectedSha256Hash(filePath, expectedSha256Hash) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }
  const untrustedFile = fs.readFileSync(filePath)
  const computedSha256Hash = crypto
    .createHash('sha256')
    .update(untrustedFile)
    .digest('hex')
  return computedSha256Hash === expectedSha256Hash
}
exports.fileHasExpectedSha256Hash = fileHasExpectedSha256Hash
let tmpDir
// Delete bootstrap version and maybe installed version
function cleanup() {
  return __awaiter(this, void 0, void 0, function* () {
    yield io.rmRF(`${tmpDir}`)
  })
}
function run() {
  return __awaiter(this, void 0, void 0, function* () {
    // Get requested verifier version and validate
    // SLSA_VERIFIER_CI_ACTION_REF is a utility env variable to help us test
    // the Action in CI.
    const actionRef =
      process.env.GITHUB_ACTION_REF ||
      process.env.SLSA_VERIFIER_CI_ACTION_REF ||
      ''
    let version
    try {
      version = yield getVerifierVersion(actionRef)
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      core.setFailed(
        `Invalid version provided. For the set of valid versions, see https://github.com/slsa-framework/slsa-verifier/releases. ${errMsg}`
      )
      cleanup()
      return
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slsa-verifier_'))
    const bootstrapDir = `${tmpDir}/bootstrap`
    const installDir = `${tmpDir}/${version}`
    let bootstrapVerifierPath
    try {
      // Download bootstrap version and validate SHA256 checksum
      bootstrapVerifierPath = yield tc.downloadTool(
        `https://github.com/slsa-framework/slsa-verifier/releases/download/${BOOTSTRAP_VERSION}/slsa-verifier-linux-amd64`,
        `${bootstrapDir}/${BINARY_NAME}`
      )
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      core.setFailed(`Error downloading bootstrap slsa-verifier: ${errMsg}`)
      cleanup()
      return
    }
    if (
      !fileHasExpectedSha256Hash(
        bootstrapVerifierPath,
        BOOTSTRAP_VERIFIER_SHA256
      )
    ) {
      core.setFailed(
        `Unable to verify slsa-verifier checksum. Aborting installation.`
      )
      cleanup()
      return
    }
    fs.chmodSync(bootstrapVerifierPath, 0o100)
    let downloadedBinaryPath
    try {
      // Download requested version binary and provenance
      downloadedBinaryPath = yield tc.downloadTool(
        `https://github.com/slsa-framework/slsa-verifier/releases/download/${version}/slsa-verifier-linux-amd64`,
        `${installDir}/${BINARY_NAME}`
      )
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      core.setFailed(`Error downloading slsa-verifier: ${errMsg}`)
      cleanup()
      return
    }
    let downloadedProvenancePath
    try {
      downloadedProvenancePath = yield tc.downloadTool(
        `https://github.com/slsa-framework/slsa-verifier/releases/download/${version}/slsa-verifier-linux-amd64.intoto.jsonl`,
        `${installDir}/${PROVENANCE_NAME}`
      )
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      core.setFailed(`Error downloading binary provenance: ${errMsg}`)
      cleanup()
      return
    }
    // Validate binary provenance
    try {
      const { exitCode, stdout, stderr } = yield exec.getExecOutput(
        `${bootstrapVerifierPath}`,
        [
          'verify-artifact',
          downloadedBinaryPath,
          '--provenance-path',
          downloadedProvenancePath,
          '--source-uri',
          'github.com/slsa-framework/slsa-verifier',
          '--source-tag',
          version
        ]
      )
      if (exitCode !== 0) {
        throw new Error(
          `Unable to verify binary provenance. Aborting installation. stdout: ${stdout}; stderr: ${stderr}`
        )
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      core.setFailed(`Error executing slsa-verifier: ${errMsg}`)
      cleanup()
      return
    }
    // Copy requested version to HOME directory.
    const finalDir = `${os.homedir()}/.slsa/bin/${version}`
    const finalPath = `${finalDir}/${BINARY_NAME}`
    fs.mkdirSync(finalDir, { recursive: true })
    fs.copyFileSync(downloadedBinaryPath, finalPath)
    fs.chmodSync(finalPath, 0o100)
    core.addPath(finalDir)
    core.setOutput('verifier-path', finalDir)
    cleanup()
  })
}
run()
