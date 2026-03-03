import { Octokit } from "@octokit/rest";

export interface GitHubItem {
  name: string;
  type: "file" | "dir" | "symlink" | "submodule";
  path: string;
  size: number;
  sha: string;
}

export function createOctokit(token: string | undefined): Octokit {
  return new Octokit({ auth: token });
}

export async function listDirectory(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  path: string,
): Promise<GitHubItem[]> {
  const { data } = await octokit.rest.repos.getContent({
    owner,
    repo,
    ref: branch,
    path,
  });

  if (!Array.isArray(data)) {
    throw new Error(`Expected a directory at "${path}" but got a file`);
  }

  return data as GitHubItem[];
}

export async function getFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  path: string,
): Promise<string> {
  const { data } = await octokit.rest.repos.getContent({
    owner,
    repo,
    ref: branch,
    path,
  });

  if (Array.isArray(data)) {
    throw new Error(`Expected a file at "${path}" but got a directory`);
  }

  const file = data as {
    type: string;
    content?: string;
    size: number;
    sha: string;
  };

  if (file.type !== "file") {
    throw new Error(`Unexpected content type "${file.type}" at "${path}"`);
  }

  if (file.size > 1_000_000) {
    throw new Error(
      `File "${path}" is ${file.size} bytes (>1 MB). Large files are not supported via the Contents API.`,
    );
  }

  if (!file.content) {
    throw new Error(`File "${path}" has no content`);
  }

  // GitHub returns base64 with embedded newlines — strip before decoding
  const clean = file.content.replace(/\n/g, "");
  return Buffer.from(clean, "base64").toString("utf-8");
}
