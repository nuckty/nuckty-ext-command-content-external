/**
 * content-external logic — clone or update external git repositories listed in
 * `external.json` into `external/<repo>/` (openspec `ext-command-content-external`).
 *
 * Repository preparation is explicit. The build reads prepared content from
 * configured levels and may query local Git for commit timestamps. Offline
 * operation also requires extensions that do not access the network.
 *
 * Split for testability: pure planning (`getRepoName`, `planRepos`) is separated
 * from git execution (`runPlan` against an injected `GitRunner`), so the pure
 * helpers are tested without spawning git.
 *
 * @module content-external
 */

import path from 'node:path';
import fs from 'node:fs';

/** One repo URL parsed into its target directory name (without `.git`). */
export interface RepoPlan {
    /** The original git URL as listed in `external.json`. */
    url: string;
    /** Repo name: the last path segment without `.git` (e.g. `voyahchat-content`). */
    name: string;
    /** Destination `<externalDir>/<name>`; absolute when externalDir is absolute. */
    dir: string;
    /** Clone an absent destination, update a verified clean copy, or refuse
     *  an existing dirty, mismatched or unverifiable destination. Refused
     *  destinations are left untouched. */
    action: 'clone' | 'update' | 'refuse';
    /** Why an existing destination was refused. */
    refusalReason?: 'local-changes' | 'repository-identity-mismatch' | 'repository-status-unknown';
}

export type RepoStatus = 'clean' | 'dirty' | 'none' | 'identity-mismatch' | 'unknown';

function githubIdentity(repoUrl: string): string | undefined {
    let host: string;
    let repositoryPath: string;

    const scp = /^git@github\.com:([^?#]+)$/i.exec(repoUrl);

    if (scp) {
        host = 'github.com';
        repositoryPath = scp[1]!;
    } else {
        let parsed: URL;
        try {
            parsed = new URL(repoUrl);
        } catch {
            return undefined;
        }

        host = parsed.hostname.toLowerCase();

        if (host !== 'github.com' || parsed.search || parsed.hash) return undefined;
        if (parsed.protocol === 'https:') {
            if (parsed.port) return undefined;
        } else if (parsed.protocol === 'ssh:') {
            if (parsed.username !== 'git' || parsed.password || parsed.port) return undefined;
        } else {
            return undefined;
        }
        repositoryPath = parsed.pathname.replace(/^\//, '');
    }

    if (host !== 'github.com' || repositoryPath.includes('%')) return undefined;

    const segments = repositoryPath.split('/');
    if (segments.length !== 2) return undefined;
    const [owner, rawName] = segments;
    const name = rawName!.endsWith('.git') ? rawName!.slice(0, -4) : rawName!;
    if (
        !/^[a-z0-9_.-]+$/i.test(owner!) ||
        !/^[a-z0-9_.-]+$/i.test(name) ||
        owner === '.' ||
        owner === '..' ||
        name === '.' ||
        name === '..'
    ) {
        return undefined;
    }

    return `${owner!.toLowerCase()}/${name.toLowerCase()}`;
}

function sameRepositoryIdentity(configuredUrl: string, originUrl: string): boolean {
    if (configuredUrl === originUrl) return true;

    const configuredGithub = githubIdentity(configuredUrl);

    return configuredGithub !== undefined && configuredGithub === githubIdentity(originUrl);
}

function sanitizeRemoteUrls(message: string): string {
    const withoutUserInfo = message.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1[redacted]@');
    const withoutHttpQuery = withoutUserInfo.replace(
        /([a-z][a-z0-9+.-]*:\/\/[^/?#\s]+(?:\/[^?#\s]*)?)(?:[?#][^\s]*)?/gi,
        '$1',
    );

    return withoutHttpQuery.replace(/((?:[\w.-]+@)?[a-z0-9.-]+:[^\s?#]+)(?:[?#][^\s]*)/gi, '$1');
}

/**
 * Extract the repository name from a git URL. Accepts SSH scp, `ssh://`, and
 * HTTPS path forms, with or without a trailing `.git`. Throws on a URL that has
 * no parseable name.
 */
export function getRepoName(repoUrl: string): string {
    // SSH form `git@host:org/repo.git`: drop the `host:` prefix first, then split.
    // HTTPS form `https://host/org/repo.git`: no `:`, split on `/`. Strip `.git`.
    const noGit = repoUrl.replace(/\.git$/, '');
    const afterColon = noGit.lastIndexOf(':') >= 0 ? noGit.slice(noGit.lastIndexOf(':') + 1) : noGit;
    const name = afterColon.split('/').pop()!;
    if (!name) throw new Error('Could not parse repository name from URL');
    // CMD-08: a parsed `.` or `..` (e.g. from `https://h/o/..`) makes `external/`
    // resolve to itself or its PARENT — the runner must never touch it. The
    // same applies to names with path separators or empty/whitespace.
    if (!name.trim() || /[?#%]/.test(name) || name === '.' || name === '..' || name !== path.basename(name) || /[\\/]/.test(name)) {
        throw new Error(
            'Unsafe repository name parsed from URL — the name must be a plain directory segment (no ., .., / or \\)',
        );
    }
    return name;
}

/** Ownership and working-tree status for an existing destination. Async: the
 *  real `fsStatus` goes through simple-git; tests inject a sync map. */
export type RepoStatusCheck = (dir: string, url?: string) => Promise<RepoStatus> | RepoStatus;
/** Runs git for a planned repo. Injected so tests do not spawn git. */
export interface GitRunner {
    /** Clone `url` into `dir` (parent exists). Resolves on success, rejects on error. */
    clone(url: string, dir: string): Promise<void>;
    /** Update the copy: pull, inspect LFS, then fetch listed LFS files. */
    update(dir: string, url?: string): Promise<void>;
}

/**
 * Plan what to do for each repo URL: `clone` when `external/<name>/` is absent,
 * `update` when it exists and is verified clean, and `refuse` otherwise. Takes the
 * existence/clean check as an injected function (sync or async), so it is tested
 * without git and reused by the command handler with the real `fsStatus`.
 */
export async function planRepos(
    urls: string[],
    externalDir: string,
    status: RepoStatusCheck,
): Promise<RepoPlan[]> {
    const plans: RepoPlan[] = [];
    const dirsByUrl = new Map<string, string>();
    for (const url of urls) {
        const name = getRepoName(url);
        const dir = path.join(externalDir, name);
        // CMD-08: containment — the planned directory must stay inside
        // `externalDir` (getRepoName rejects .., but resolve too, so the
        // invariant holds no matter what the name check allows).
        const resolved = path.resolve(dir);
        if (!resolved.startsWith(path.resolve(externalDir) + path.sep)) {
            throw new Error(
                `Planned directory "${dir}" escapes the external directory "${externalDir}"`,
            );
        }
        // CMD-08: two URLs with the same basename plan the SAME destination —
        // the second clone would delete the first. Reject duplicates before
        // any runner executes.
        const seen = dirsByUrl.get(resolved);
        if (seen !== undefined) {
            throw new Error(
                `Duplicate repository destination "${dir}" for repositories ${getRepoName(seen)} and ${name} — ` +
                    'two repos may not share one external directory',
            );
        }
        dirsByUrl.set(resolved, url);
        if (fs.lstatSync(externalDir, { throwIfNoEntry: false }) && fs.lstatSync(externalDir).isSymbolicLink()) {
            throw new Error('External directory must not be a symbolic link');
        }
        if (fs.lstatSync(dir, { throwIfNoEntry: false }) && fs.lstatSync(dir).isSymbolicLink()) {
            throw new Error(`Repository destination must not be a symbolic link: ${dir}`);
        }
        const st = await status(dir, url);
        // Only an absent destination is cloned; every unverified or unsafe
        // existing destination is refused without suggesting it has local edits.
        const action: RepoPlan['action'] = st === 'clean' ? 'update' : st === 'none' ? 'clone' : 'refuse';
        const refusalReason = st === 'dirty'
            ? 'local-changes'
            : st === 'identity-mismatch'
                ? 'repository-identity-mismatch'
                : st === 'unknown'
                    ? 'repository-status-unknown'
                    : undefined;
        plans.push({ url, name, dir, action, ...(refusalReason ? { refusalReason } : {}) });
    }
    return plans;
}

/** Verify the repository root and clean working tree, plus origin identity
 *  when url is supplied. Git inspection failures return unknown. */
export async function fsStatus(dir: string, url?: string): Promise<RepoStatus> {
    if (!fs.lstatSync(dir, { throwIfNoEntry: false })) return 'none';
    if (fs.lstatSync(dir).isSymbolicLink()) return 'unknown';
    try {
        const { simpleGit } = await import('simple-git');
        const git = simpleGit(dir);
        const root = (await git.revparse(['--show-toplevel'])).trim();
        if (fs.realpathSync(root) !== fs.realpathSync(dir)) {
            return 'identity-mismatch';
        }
        if (url) {
            const origin = await git.remote(['get-url', 'origin']);
            if (typeof origin !== 'string') return 'unknown';
            if (!sameRepositoryIdentity(url, origin.trim())) return 'identity-mismatch';
        }
        const status = await git.status();
        return status.isClean() ? 'clean' : 'dirty';
    } catch {
        // Unknown ownership or failed git inspection must refuse mutation.
        return 'unknown';
    }
}

/** Outcome of running the plan against a single repo. */
export interface RepoResult {
    name: string;
    action: 'clone' | 'update' | 'refuse';
    ok: boolean;
    error?: string;
}

/**
 * Build a GitRunner backed by simple-git. Clone publishes a temporary sibling
 * after success. Update runs pull, then git lfs ls-files; only a nonempty list
 * triggers git lfs pull. LFS inspection and fetch errors fail the update.
 */
export function makeGitRunner(loadGit: () => Promise<Pick<typeof import('simple-git'), 'simpleGit'>> = () => import('simple-git')): GitRunner {
    return {
        async clone(url, dir) {
            const { simpleGit } = await loadGit();
            // Clone into a TEMP SIBLING, then rename on success (CMD-07): an
            // interrupted clone must never leave a half-finished directory
            // at the final path where a later run would see "a repo" or a
            // failed attempt would look like a lost copy. The runner only
            // reaches `clone` when the destination is absent (planning turns
            // an existing/dirty copy into `refuse`), so nothing is destroyed.
            fs.mkdirSync(path.dirname(dir), { recursive: true });
            const tmp = fs.mkdtempSync(`${dir}.cloning-`);
            try {
                await simpleGit().clone(url, tmp);
                if (fs.lstatSync(dir, { throwIfNoEntry: false })) {
                    throw new Error(`Repository destination appeared during clone: ${dir}`);
                }
                fs.renameSync(tmp, dir);
            } catch (err) {
                // Clean up the partial clone; the final path stays untouched.
                fs.rmSync(tmp, { recursive: true, force: true });
                throw err;
            }
        },
        async update(dir, url) {
            const { simpleGit } = await loadGit();
            const g = simpleGit(dir);
            if (url && await fsStatus(dir, url) !== 'clean') {
                throw new Error('Repository identity or clean status changed; refusing update');
            }
            await g.pull();
            // An empty LFS listing skips the fetch. Inspection and fetch errors
            // must propagate so success does not hide missing binary assets.
            const usesLfs = String(await g.raw(['lfs', 'ls-files'])).trim().length > 0;
            if (!usesLfs) return;
            try {
                await g.raw(['lfs', 'pull']);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                throw new Error(`git lfs pull failed (repo uses LFS assets): ${msg}`);
            }
        },
    };
}

/**
 * Execute a plan: clone or update each repo via the injected `GitRunner`. In
 * `--dry-run`, nothing is run and every repo resolves `{ ok: true }` (the plan
 * itself is the report). The real runner owns temporary clone publication.
 * Returns one result per repo in plan order.
 */
export async function runPlan(
    plan: RepoPlan[],
    runner: GitRunner,
    dryRun: boolean,
): Promise<RepoResult[]> {
    const results: RepoResult[] = [];
    for (const repo of plan) {
        if (dryRun) {
            results.push({ name: repo.name, action: repo.action, ok: true });
            continue;
        }
        try {
            if (repo.action === 'clone') {
                await runner.clone(repo.url, repo.dir);
            } else if (repo.action === 'update') {
                await runner.update(repo.dir, repo.url);
            } else {
                // 'refuse': never delete or update an existing unverified copy.
                results.push({
                    name: repo.name,
                    action: 'refuse',
                    ok: false,
                    error: repo.refusalReason === 'local-changes'
                        ? `refusing to update: ${repo.dir} has local changes`
                        : repo.refusalReason === 'repository-identity-mismatch'
                            ? `refusing to update: ${repo.dir} belongs to a different repository`
                            : `refusing to update: repository status for ${repo.dir} could not be verified`,
                });
                continue;
            }
            results.push({ name: repo.name, action: repo.action, ok: true });
        } catch (e) {
            results.push({ name: repo.name, action: repo.action, ok: false, error: sanitizeRemoteUrls((e as Error).message) });
        }
    }
    return results;
}

