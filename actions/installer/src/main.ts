/*
 * Copyright 2022 SLSA Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import * as tc from '@actions/tool-cache'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { BOOTSTRAP_VERSION, BOOTSTRAP_DIGEST } from './bootstrap'
import * as utils from './utils'

const SLSA_REPO = 'https://github.com/slsa-framework/slsa-verifier'

export async function run(): Promise<void> {
  let tmpDir
  try {
    // System information
    const OS = utils.getOS(process.platform)
    const ARCH = utils.getArch(process.arch)
    const EXE = OS === 'windows' ? '.exe' : ''
    const BIN_NAME = `slsa-verifier${EXE}`

    // Authenticate with GitHub
    const octokit = github.getOctokit(core.getInput('token'))

    // Validate requested version
    let version =
      core.getInput('version') ||
      process.env.GITHUB_ACTION_REF ||
      process.env.SLSA_VERIFIER_CI_ACTION_REF
    try {
      if (utils.isSha(version)) {
        version = await utils.getVersionBySha(version, octokit)
      } else if (utils.validVersion(version)) {
        version = await utils.getVersion(version, octokit)
      } else if (version === 'latest') {
        version = await utils.getLatestVersion(octokit)
      } else throw Error
    } catch (error) {
      // If we get an error message, then something when wrong with a valid
      // version. If we get a blank error, that means we got an invalid version.
      const message = error instanceof Error ? error.message : ''
      if (message) {
        throw Error(
          `${message} - For a list of valid versions, see ${SLSA_REPO}/releases`
        )
      } else {
        throw Error(
          `Invalid version ${version} - For a list of valid versions, see ${SLSA_REPO}/releases`
        )
      }
    }
    core.info(`🏗️ Setting up slsa-verifier ${version}`)
    core.setOutput('version', version)

    // Create temp directory for downloading non-cached versions
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slsa-verifier_'))

    // Check if the slsa-verifier is already in the tool-cache
    const cache = core.getInput('cache')
    let mainCachePath = tc.find('slsa-verifier', version.substring(1))
    core.setOutput('cache-hit', cache && !!mainCachePath)
    if (!cache || !mainCachePath) {
      // Check if the bootstrap slsa-verifier is already in the tool-cache
      let bootstrapCachePath = tc.find(
        'slsa-verifier',
        BOOTSTRAP_VERSION.substring(1)
      )
      if (!cache || !bootstrapCachePath) {
        // Download tool into tmpDir
        core.info('⏬ Downloading bootstrap slsa-verifier')
        const bootstrapUrl = `${SLSA_REPO}/releases/download/${BOOTSTRAP_VERSION}/slsa-verifier-${OS}-${ARCH}${EXE}`
        const bootstrapBin = await tc.downloadTool(
          bootstrapUrl,
          path.join(path.join(tmpDir, 'bootstrap'), BIN_NAME)
        )
        fs.chmodSync(bootstrapBin, 0o755) // chmod +x

        // Compare the SHA256 of the download to the known expected value
        core.info('🔍 Verifying bootstrap slsa-verifier')
        if (!utils.checkFileSHA256(bootstrapBin, BOOTSTRAP_DIGEST[OS][ARCH])) {
          throw Error('bootstrap slsa-verifier SHA256 verification failed')
        }
        core.info('✅ Verified bootstrap slsa-verifier')

        // Cache the bootstrap slsa-verifier download, but don't add it to PATH
        bootstrapCachePath = await tc.cacheFile(
          bootstrapBin,
          BIN_NAME,
          'slsa-verifier',
          BOOTSTRAP_VERSION.substring(1) // remove leading 'v'
        )
      } else core.info('📥 Loaded bootstrap from runner cache')
      // Because this isn't in our PATH, we need to build the final path to the binary
      const bootstrapCacheBin = path.join(bootstrapCachePath, BIN_NAME)

      // If requested version is same as bootstrap then we can just use that
      // directly after verifying it's digest
      if (version !== BOOTSTRAP_VERSION) {
        // Download tool into tmpDir
        core.info('⏬ Downloading slsa-verifier')
        const mainUrl = `${SLSA_REPO}/releases/download/${version}/slsa-verifier-${OS}-${ARCH}${EXE}`
        const mainBin = await tc.downloadTool(
          mainUrl,
          path.join(path.join(tmpDir, version), BIN_NAME)
        )
        fs.chmodSync(mainBin, 0o755) // chmod +x

        // Download tool attestation next to main tool
        core.info('🔏 Downloading slsa-verifier attestation')
        const attestation = await tc.downloadTool(
          `${mainUrl}.intoto.jsonl`,
          `${mainBin}.intoto.jsonl`
        )

        // Run the bootstrap slsa-verifier against the version we wanted
        core.info('🔍 Verifying slsa-verifier')
        try {
          // This will exit 1 on error and display stdout and stderr automatically
          await exec.getExecOutput(bootstrapCacheBin, [
            'verify-artifact',
            mainBin,
            '--provenance-path',
            attestation,
            '--source-uri',
            'github.com/slsa-framework/slsa-verifier',
            '--source-tag',
            version
          ])

          /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
        } catch (_) {
          throw Error('slsa-verifier signature verification failed')
        }
        core.info('✅ Verified slsa-verifier')

        // Cache the slsa-verifier download
        mainCachePath = await tc.cacheFile(
          mainBin,
          BIN_NAME,
          'slsa-verifier',
          version.substring(1) // remove leading 'v'
        )
      } else {
        core.info('📥 Loaded from bootstrap cache due to same version')
        mainCachePath = bootstrapCachePath
        core.setOutput('cache-hit', true)
      }
    } else core.info('📥 Loaded from runner cache')
    // Add the cached slsa-verifier to our PATH
    core.addPath(mainCachePath)

    // Cleanup tmpDir
    fs.rmSync(tmpDir, { recursive: true, force: true })
    core.info('🎉 slsa-verifier is ready')
  } catch (error) {
    // Cleanup tmpDir before terminating during a failure
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })

    if (error instanceof Error) core.setFailed(error.message)
    else core.setFailed(error as string)
  }
}
