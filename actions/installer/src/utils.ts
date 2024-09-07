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

import * as fs from 'fs'
import * as crypto from 'crypto'

import { GitHub } from '@actions/github/lib/utils'

export function getArch(arch: string): string {
  switch (arch) {
    case 'x64':
      return 'amd64'
    case 'arm64':
      return arch
    default:
      throw Error(`Unsupported architecture ${arch}`)
  }
}

export function getOS(os: string): string {
  switch (os) {
    case 'win32':
      return 'windows'
    case 'linux':
    case 'darwin':
      return os
    default:
      throw Error(`Unsupported OS ${os}`)
  }
}

export function validVersion(version: string): boolean {
  const re = /^(v[0-9]+\.[0-9]+\.[0-9]+)$/
  if (re.test(version)) {
    return true
  } else {
    return false
  }
}

export function isSha(sha: string): boolean {
  const re = /^[a-f\d]{40}$/
  if (re.test(sha)) {
    return true
  } else {
    return false
  }
}

export async function getLatestVersion(
  octokit: InstanceType<typeof GitHub>
): Promise<string> {
  try {
    return (
      await octokit.rest.repos.getLatestRelease({
        owner: 'slsa-framework',
        repo: 'slsa-verifier'
      })
    ).data.tag_name

    /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
  } catch (_) {
    throw Error('Could not find latest release')
  }
}

export async function getVersion(
  version: string,
  octokit: InstanceType<typeof GitHub>
): Promise<string> {
  try {
    return (
      await octokit.rest.repos.getReleaseByTag({
        owner: 'slsa-framework',
        repo: 'slsa-verifier',
        tag: version
      })
    ).data.tag_name

    /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
  } catch (_) {
    throw Error(`Could not find release ${version}`)
  }
}

export async function getVersionBySha(
  sha: string,
  octokit: InstanceType<typeof GitHub>
): Promise<string> {
  const tags = (
    await octokit.rest.repos.listTags({
      owner: 'slsa-framework',
      repo: 'slsa-verifier'
    })
  ).data
  for (const tag of tags) {
    if (tag.commit.sha === sha) {
      try {
        // Multiple tags can exist for the same commit so we should check
        // them until we get a valid match or exhausted all options
        return getVersion(tag.name, octokit)

        /* eslint-disable-next-line @typescript-eslint/no-unused-vars, no-empty */
      } catch (_) {}
    }
  }
  throw Error(`Could not find tag or release associated with commit ${sha}`)
}

export function checkFileSHA256(file: string, sha: string): boolean {
  const calculated = crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex')
  return calculated === sha
}
