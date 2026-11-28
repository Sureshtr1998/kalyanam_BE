import { handle } from "./actions.js";
import { signRenderToken } from "./renderToken.js";

/*
 * Developer tab. A request from the panel becomes a GitHub issue labelled
 * ops-read or ops-write; the "Ops agent" GitHub Action (.github/workflows/
 * ops-agent.yml in each repo) runs Claude Code on it:
 *  - read:  answers in an issue comment, changes nothing
 *  - write: makes the change on a branch and opens a PR; Vercel builds a
 *           preview of that branch
 * "Deploy" merges the PR into master, which Vercel deploys to production.
 * Merging happens from an admin's click, or by itself for the SEO agent's
 * blog-only changes (seo.js checks every changed file is under the blogs).
 */

const OWNER = () => process.env.GITHUB_OWNER || "Sureshtr1998";
export const REPOS = { fe: () => process.env.GITHUB_REPO_FE || "kalyanam_FE", be: () => process.env.GITHUB_REPO_BE || "kalyanam_BE" };
export const devConfigured = () => !!process.env.GITHUB_TOKEN;

export const gh = async (method, path, body) => {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub: ${data.message || res.status}`);
  return data;
};

export const repoPath = (repo) => {
  const name = REPOS[repo]?.();
  if (!name) throw new Error("Choose the website (fe) or backend (be)");
  return `/repos/${OWNER()}/${name}`;
};

export const createRequest = async ({ repo, mode, request, by }) => {
  if (!["read", "write"].includes(mode)) throw new Error("Mode must be read or write");
  const text = String(request || "").trim();
  if (text.length < 5) throw new Error("Describe what you need");
  const issue = await gh("POST", `${repoPath(repo)}/issues`, {
    title: `[Ops ${mode}] ${text.split("\n")[0].slice(0, 80)}`,
    body: `${text}\n\n---\nRequested from the admin Ops tab by ${by || "admin"}. Mode: **${mode}**${mode === "read" ? " (answer only, change nothing)" : " (change on a branch, open a PR, never merge)"}.`,
    labels: [`ops-${mode}`],
  });
  return { repo, number: issue.number, url: issue.html_url };
};

/** A Vercel preview URL for a commit, from the GitHub deployments Vercel creates. */
export const previewFor = async (path, sha) => {
  const deps = await gh("GET", `${path}/deployments?sha=${sha}&per_page=5`);
  for (const d of deps) {
    const statuses = await gh("GET", `${path}/deployments/${d.id}/statuses?per_page=5`);
    const ok = statuses.find((s) => s.environment_url || s.target_url);
    if (ok) return { url: ok.environment_url || ok.target_url, state: ok.state };
  }
  return null;
};

export const listRequests = async () => {
  const out = [];
  for (const repo of Object.keys(REPOS)) {
    const path = repoPath(repo);
    const [issues, pulls] = await Promise.all([
      gh("GET", `${path}/issues?state=all&labels=ops-read,ops-write&per_page=15`).catch(() => []),
      gh("GET", `${path}/pulls?state=all&per_page=30`).catch(() => []),
    ]);
    // The label filter is AND in GitHub, so fetch each label when the combined query returns nothing.
    const labelled = issues.length
      ? issues
      : [
          ...(await gh("GET", `${path}/issues?state=all&labels=ops-read&per_page=10`).catch(() => [])),
          ...(await gh("GET", `${path}/issues?state=all&labels=ops-write&per_page=10`).catch(() => [])),
        ];
    for (const i of labelled.filter((x) => !x.pull_request)) {
      const comments = i.comments ? await gh("GET", `${path}/issues/${i.number}/comments?per_page=10`) : [];
      const pr = pulls.find((p) => new RegExp(`#${i.number}\\b`).test(p.body || "") || (p.head?.ref || "").includes(`issue-${i.number}`));
      const branch = pr ? null : await agentBranch(path, i.number);
      out.push({
        repo,
        number: i.number,
        title: i.title.replace(/^\[Ops (read|write)\]\s*/, ""),
        mode: i.labels.some((l) => l.name === "ops-write") ? "write" : "read",
        state: i.state,
        createdAt: i.created_at,
        url: i.html_url,
        replies: comments.filter((c) => c.user?.type === "Bot" || /claude/i.test(c.user?.login || "")).map((c) => ({ body: c.body, at: c.created_at })).slice(-3),
        pr: pr
          ? {
              number: pr.number,
              url: pr.html_url,
              state: pr.merged_at ? "merged" : pr.state,
              branch: pr.head.ref,
              preview: pr.state === "open" ? await previewFor(path, pr.head.sha).catch(() => null) : null,
            }
          : null,
        // The agent pushed a branch but no PR yet: Deploy opens the PR and merges it.
        branch: branch
          ? { name: branch.name, preview: await previewFor(path, branch.sha).catch(() => null) }
          : null,
      });
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};

/** The newest claude/issue-N-… branch the Action pushed for an issue. */
export const agentBranch = async (path, number) => {
  const refs = await gh("GET", `${path}/git/matching-refs/heads/claude/issue-${number}-`).catch(() => []);
  const ref = refs.at(-1);
  return ref ? { name: ref.ref.replace("refs/heads/", ""), sha: ref.object.sha } : null;
};

/** Asks the agent to adjust its change (a follow-up comment the Action picks up). */
export const followUp = (repo, number, text) =>
  gh("POST", `${repoPath(repo)}/issues/${number}/comments`, { body: `@claude ${String(text).slice(0, 4000)}` });

/**
 * Deploy = squash-merge the request's change into master. Admin click only.
 * Uses the PR if the agent opened one, otherwise opens it from the agent's branch.
 */
export const deploy = async (repo, issueNumber, { sha } = {}) => {
  const path = repoPath(repo);
  const issue = await gh("GET", `${path}/issues/${issueNumber}`);
  const pulls = await gh("GET", `${path}/pulls?state=open&per_page=50`);
  let pr = pulls.find((p) => new RegExp(`#${issueNumber}\\b`).test(p.body || "") || (p.head?.ref || "").includes(`issue-${issueNumber}`));
  if (!pr) {
    const branch = await agentBranch(path, issueNumber);
    if (!branch) throw new Error("The agent hasn't pushed a change for this request yet");
    pr = await gh("POST", `${path}/pulls`, {
      title: issue.title.replace(/^\[Ops (read|write)\]\s*/, ""),
      head: branch.name,
      base: "master",
      body: `Closes #${issueNumber}\n\nDeployed from the admin Ops tab.`,
    });
  }
  const prNumber = pr.number;
  pr = await gh("GET", `${path}/pulls/${prNumber}`);
  if (pr.state !== "open") throw new Error("This PR is not open");
  if (pr.base.ref !== "master") throw new Error(`This PR targets ${pr.base.ref}, not master`);
  // With a sha, GitHub refuses the merge if the branch moved since it was checked.
  const r = await gh("PUT", `${path}/pulls/${prNumber}/merge`, { merge_method: "squash", ...(sha ? { sha } : {}) });
  return { merged: r.merged, sha: r.sha };
};

/** Starts the "Ops render" workflow in the backend repo (draws organic post images). */
export const dispatchRender = () =>
  gh("POST", `${repoPath("be")}/dispatches`, {
    event_type: "ops-render",
    // Where to fetch the queue and a 3-hour pass, so no secrets are stored in GitHub.
    client_payload: { base_url: process.env.BASE_URL, token: signRenderToken() },
  });

/** Scheduled SEO/dev ideas become requests when they run. */
handle("dev.request", async (action) => {
  const { repo = "fe", request, seo } = action.payload;
  // payload.mode is the agent module's mode ("live"/"shadow"), stamped by propose(); the request's own
  // read/write mode is devMode (older cards kept it in mode, so a read/write mode is still honoured).
  const mode = ["read", "write"].includes(action.payload.devMode) ? action.payload.devMode : action.payload.mode === "read" ? "read" : "write";
  const made = await createRequest({ repo, mode, request, by: seo ? "Ops SEO agent" : "Ops agent (scheduled idea)" });
  // An SEO change is checked and deployed by itself (seo.deploy in seo.js).
  if (seo) return { ...made, next: { type: "seo.deploy", runAt: new Date(Date.now() + 3600000), payload: { issue: made.number, requestedAt: new Date() } } };
  return made;
});
