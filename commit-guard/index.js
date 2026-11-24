import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

export const name = 'nervdog-commit-guard'
export const inject = ['workingDirectory']

const FILE_EDIT_TOOLS = new Set([
  'edit',
  'write',
  'delete',
  'delete_file',
  'multi_edit',
  'multiedit',
  'notebook_edit',
  'notebookedit',
  'apply_patch',
  'patch_file',
  'create_file',
  'str_replace_editor',
])

const SHELL_TOOLS = new Set([
  'pwsh',
  'bash',
  'shell',
  'run_shell',
  'terminal',
])

const MAX_LIST_FILES = 10
const MAX_REPO_CACHE = 512
const NEGATIVE_CACHE_TTL_MS = 60_000
const GIT_MAX_BUFFER = 32 * 1024 * 1024

function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  return {
    commitGuard: cfg.commitGuard !== false,
    ciGuard: cfg.ciGuard !== false,
    maxCommitSteersPerTurn: clampInt(cfg.maxCommitSteersPerTurn, 2, 1, 5),
    maxCiSteersPerPush: clampInt(cfg.maxCiSteersPerPush, 2, 1, 5),
    gitTimeoutMs: clampInt(cfg.gitTimeoutMs, 5000, 1000, 30_000),
  }
}

function clampInt(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const n = Math.trunc(value)
  if (n < min) return min
  if (n > max) return max
  return n
}

function toPosixPath(p) {
  let s = String(p).replace(/\\/g, '/')
  if (process.platform === 'win32') {
    const msys = s.match(/^\/([a-zA-Z])(\/|$)/)
    if (msys) s = `${msys[1]}:/${s.slice(3)}`
  }
  return s.replace(/\/+$/, '')
}

function pathKey(p) {
  const posix = toPosixPath(p)
  return process.platform === 'win32' ? posix.toLowerCase() : posix
}

function isSubagent(session) {
  return session?.header?.origin === 'subagent' || Boolean(session?.header?.parentSession)
}

function createGuardMessage(text, summary) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({
      kind: 'nervdog-commit-guard',
      form: 'notice',
      summary,
    }),
  })
}

function extractEditedPaths(toolName, args, baseCwd) {
  if (!toolName || !args || typeof args !== 'object') return []
  const lower = String(toolName).toLowerCase()
  if (!FILE_EDIT_TOOLS.has(lower)) return []

  const rawPaths = []
  for (const key of ['file_path', 'path', 'notebook_path', 'target_file', 'destination']) {
    if (typeof args[key] === 'string' && args[key].trim()) {
      rawPaths.push(args[key].trim())
    }
  }
  for (const key of ['paths', 'files']) {
    if (Array.isArray(args[key])) {
      for (const item of args[key]) {
        if (typeof item === 'string' && item.trim()) {
          rawPaths.push(item.trim())
        } else if (item && typeof item === 'object') {
          const p = item.file_path ?? item.path
          if (typeof p === 'string' && p.trim()) rawPaths.push(p.trim())
        }
      }
    }
  }
  if (lower === 'apply_patch') {
    const patchText = typeof args.patch === 'string' ? args.patch : (typeof args.input === 'string' ? args.input : '')
    if (patchText) {
      for (const line of patchText.split(/\r?\n/)) {
        const m = line.match(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+)$/)
        if (m && m[1].trim()) rawPaths.push(m[1].trim())
      }
    }
  }

  const out = []
  for (const raw of rawPaths) {
    const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(baseCwd || process.cwd(), raw)
    out.push(resolved)
  }
  return out
}

function resolveSimpleShellVars(command) {
  const vars = new Map()
  if (typeof command !== 'string') return vars
  // PowerShell: $repo = '...' or $repo = "..."
  for (const m of command.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s;#|&]+))/g)) {
    vars.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '')
  }
  // POSIX sh/bash: repo='...' or repo="..." or export repo=...
  for (const m of command.matchAll(/(?:^|[;\n&|]\s*)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:'([^']*)'|"([^"]*)"|([^\s;#|&]+))/g)) {
    vars.set(m[1], m[2] ?? m[3] ?? m[4] ?? '')
  }
  return vars
}

function expandSimpleVar(raw, vars) {
  if (!raw) return null
  // PowerShell $var or ${var}
  const ps = raw.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)
  if (ps) {
    return vars.get(ps[1]) ?? vars.get(ps[1].toLowerCase()) ?? null
  }
  // Unexpanded variable/expression token: never climb ancestor into another repo
  if (/[$%`]/.test(raw)) return null
  return raw
}

function extractGitPushWorkdir(command, fallbackCwd) {
  if (typeof command !== 'string') return fallbackCwd
  const vars = resolveSimpleShellVars(command)

  // Find the segment containing `git ... push`
  const segments = command.split(/[\r\n;&|]+/)
  const pushSegment = segments.find(seg => /\bgit\b[^|;&\r\n]*\bpush\b/i.test(seg)) || command

  // Match `git -C "path" ... push` or `git -C $var ... push`
  const match = pushSegment.match(/\bgit\s+-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i)
  if (match) {
    const rawTarget = match[1] || match[2] || match[3]
    const expanded = expandSimpleVar(rawTarget, vars)
    if (!expanded) return null
    const resolved = path.isAbsolute(expanded)
      ? path.normalize(expanded)
      : path.resolve(fallbackCwd || process.cwd(), expanded)
    try {
      return fs.existsSync(resolved) ? resolved : null
    } catch {
      return null
    }
  }

  // If the command changed directories earlier (`cd <dir>` / `Set-Location <dir>`), avoid misattributing to fallbackCwd
  if (/(?:^|[\r\n;&|]\s*)(?:cd|chdir|set-location|sl|pushd|push-location)\s+/i.test(command)) {
    const cdMatches = [...command.matchAll(/(?:^|[\r\n;&|]\s*)(?:cd|chdir|set-location|sl|pushd|push-location)\s+(?:-Path\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;#|&]+))/gi)]
    const lastCd = cdMatches.at(-1)
    if (lastCd) {
      const rawDir = lastCd[1] || lastCd[2] || lastCd[3]
      const expanded = expandSimpleVar(rawDir, vars)
      if (!expanded) return null
      const resolved = path.isAbsolute(expanded)
        ? path.normalize(expanded)
        : path.resolve(fallbackCwd || process.cwd(), expanded)
      try {
        return fs.existsSync(resolved) ? resolved : null
      } catch {
        return null
      }
    }
    return null
  }

  return fallbackCwd
}

function existingAncestor(dirPath) {
  let cur = dirPath
  for (let i = 0; i < 32; i++) {
    if (!cur) return null
    try {
      if (fs.existsSync(cur)) return cur
    } catch {
      return null
    }
    const parent = path.dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
  return null
}

async function runGit(args, cwd, timeoutMs, signal) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    signal,
  })
  return stdout
}

function parseStatusPorcelainZ(raw) {
  const parts = raw.split('\0')
  const entries = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    const relPath = entry.slice(3)
    entries.push({ code, path: relPath })
    if (code[0] === 'R' || code[0] === 'C') i++
  }
  return entries
}

function formatCommitSteerMessage(dirtyByRepo) {
  const sections = []
  let totalFiles = 0
  for (const [repoRoot, files] of dirtyByRepo.entries()) {
    totalFiles += files.length
    const shown = files.slice(0, MAX_LIST_FILES).map(f => `- \`${f}\``).join('\n')
    const more = files.length > MAX_LIST_FILES ? `\n- …等共 ${files.length} 个文件` : ''
    sections.push(`仓库 \`${repoRoot}\`（${files.length} 个）：\n${shown}${more}`)
  }

  const summary = `提交守卫：发现 ${totalFiles} 个本会话改动尚未提交`
  const text = [
    `<commit-guard>`,
    `本会话改过但尚未 commit 的 git 仓库文件（共 ${totalFiles} 个）：`,
    '',
    ...sections,
    '',
    `要求：`,
    `1. 如果本次改动已完成且项目规矩要求直接提交（例如 Nervdog AGENTS.md §17），请立即只按 pathspec 提交你自己的文件（\`git commit -m "..." -- <路径>\`；切勿用 \`git add -A\` 带入别人未提交的改动），需要推送的项目请一并 \`git push\`，并在最终回复中附上本次 commit 短 SHA 与推送状态。`,
    `2. 如果用户明确要求先不提交，或当前只是中间态，请明确向用户标注「未提交（仅本地修改）」并列出上述文件，不要声称已完成进版本。`,
    `</commit-guard>`,
  ].join('\n')

  return { text, summary }
}

export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  const stateByRoot = new Map()
  const parentBySession = new Map()
  const repoRootCache = new Map()

  function rememberParent(session) {
    if (!session?.id) return
    const parentId = session.header?.parentSession
    if (parentId) parentBySession.set(session.id, parentId)
  }

  function resolveRootSessionId(session) {
    rememberParent(session)
    let cur = session.id
    for (let i = 0; i < 16; i++) {
      const parent = parentBySession.get(cur)
      if (!parent || parent === cur) break
      cur = parent
    }
    return cur
  }

  function getOrCreateState(rootSessionId) {
    let state = stateByRoot.get(rootSessionId)
    if (!state) {
      state = {
        hydrated: false,
        editedFiles: new Map(), // pathKey -> absPath
        lastTurn: -1,
        commitSteersThisTurn: 0,
        lastCommitFingerprint: null,
        ciSteersThisTurn: 0,
        pushed: null, // { repoRoot, sha, pushedAt, blocks }
        pendingPushChecks: new Set(),
      }
      stateByRoot.set(rootSessionId, state)
    }
    return state
  }

  function recordEditedPaths(rootSessionId, absPaths) {
    if (!absPaths.length) return
    const state = getOrCreateState(rootSessionId)
    for (const absPath of absPaths) {
      const normalized = toPosixPath(absPath)
      // Never track internal .git metadata edits
      if (/(?:^|\/)\.git(?:\/|$)/i.test(normalized)) continue
      state.editedFiles.set(pathKey(absPath), absPath)
    }
  }

  function hydrateFromSessionLog(session, state) {
    if (state.hydrated) return
    state.hydrated = true
    if (typeof session.ownEvents !== 'function') return

    let cwd = session.header?.cwd || ctx.workingDirectory.get(session)
    const pendingCalls = new Map()
    for (const event of session.ownEvents()) {
      if (event.type === 'workspace-root/change' && typeof event.data?.cwd === 'string') {
        cwd = event.data.cwd
      } else if (event.type === 'tool/call') {
        pendingCalls.set(event.data.callId, {
          name: event.data.name,
          arguments: event.data.arguments,
          cwd,
        })
      } else if (event.type === 'tool/result') {
        const callId = event.data?.message?.toolCallId
        const call = callId ? pendingCalls.get(callId) : undefined
        if (!call) continue
        pendingCalls.delete(callId)
        if (event.data.error || event.data.message?.isError) continue
        let parsedArgs = null
        try {
          parsedArgs = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments
        } catch {
          parsedArgs = null
        }
        const paths = extractEditedPaths(call.name, parsedArgs, call.cwd)
        recordEditedPaths(session.id, paths)
      }
    }
  }

  async function findRepoRoot(dirPath, signal) {
    const anchor = existingAncestor(dirPath)
    if (!anchor) return null
    const key = pathKey(anchor)
    const cached = repoRootCache.get(key)
    if (cached !== undefined) {
      if (cached.root !== null) return cached.root
      if (Date.now() - cached.at < NEGATIVE_CACHE_TTL_MS) return null
    }
    if (repoRootCache.size >= MAX_REPO_CACHE) repoRootCache.clear()
    try {
      const out = (await runGit(['rev-parse', '--show-toplevel'], anchor, cfg.gitTimeoutMs, signal)).trim()
      const root = out ? path.normalize(out) : null
      repoRootCache.set(key, { root, at: Date.now() })
      return root
    } catch {
      repoRootCache.set(key, { root: null, at: Date.now() })
      return null
    }
  }

  function loadCiWait(repoRoot) {
    const scriptPath = path.join(repoRoot, '.claude', 'scripts', 'ci-wait.js')
    if (!fs.existsSync(scriptPath)) return null
    try {
      const mod = require(scriptPath)
      if (mod && typeof mod.look === 'function' && typeof mod.BRANCH === 'string') {
        return mod
      }
      return null
    } catch (err) {
      ctx.logger.warn(`nervdog-commit-guard: failed to load ci-wait.js: ${String(err)}`)
      return null
    }
  }

  async function recordPushIfApplicable(rootSessionId, workdir) {
    if (!cfg.ciGuard) return
    const repoRoot = await findRepoRoot(workdir)
    if (!repoRoot) return
    const ci = loadCiWait(repoRoot)
    if (!ci) return
    try {
      const sha = (await runGit(['rev-parse', 'HEAD'], repoRoot, cfg.gitTimeoutMs)).trim()
      if (!sha) return
      // Check HEAD is pushed to origin/<BRANCH>
      await runGit(['merge-base', '--is-ancestor', sha, `origin/${ci.BRANCH}`], repoRoot, cfg.gitTimeoutMs)
      const state = getOrCreateState(rootSessionId)
      state.pushed = { repoRoot, sha, pushedAt: Date.now(), blocks: 0 }
    } catch {
      // Not pushed to tracked branch or git error — ignore
    }
  }

  ctx.on('session/created', (session) => {
    rememberParent(session)
  })

  ctx.on('session/disposed', (session) => {
    if (!session?.id) return
    stateByRoot.delete(session.id)
    parentBySession.delete(session.id)
  })

  ctx.on('tools/result', (exec, result) => {
    if (!exec?.agent?.session || result?.isError) return
    const session = exec.agent.session
    const rootId = resolveRootSessionId(session)
    const sessionCwd = ctx.workingDirectory.get(session)

    if (cfg.commitGuard) {
      const edited = extractEditedPaths(exec.name, exec.arguments, sessionCwd)
      if (edited.length > 0) {
        recordEditedPaths(rootId, edited)
      }
    }

    if (cfg.ciGuard && !isSubagent(session) && SHELL_TOOLS.has(String(exec.name).toLowerCase())) {
      const command = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments.command : null
      if (typeof command === 'string' && /\bgit\b[^|;&\n]*\bpush\b/i.test(command)) {
        const argWorkdir = exec.arguments.workdir ?? exec.arguments.cwd
        const baseWorkdir = typeof argWorkdir === 'string' && argWorkdir.trim()
          ? (path.isAbsolute(argWorkdir) ? path.normalize(argWorkdir) : path.resolve(sessionCwd, argWorkdir))
          : sessionCwd
        const pushWorkdir = extractGitPushWorkdir(command, baseWorkdir)
        if (pushWorkdir) {
          const state = getOrCreateState(rootId)
          const p = recordPushIfApplicable(rootId, pushWorkdir).finally(() => {
            state.pendingPushChecks.delete(p)
          })
          state.pendingPushChecks.add(p)
        }
      }
    }
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (!agent?.session || signal?.aborted) return
    const session = agent.session
    if (isSubagent(session)) return

    const state = getOrCreateState(session.id)
    hydrateFromSessionLog(session, state)

    if (state.lastTurn !== turn) {
      state.lastTurn = turn
      state.commitSteersThisTurn = 0
      state.lastCommitFingerprint = null
      state.ciSteersThisTurn = 0
    }

    // 1. Guard uncommitted files edited in this session
    if (cfg.commitGuard && state.editedFiles.size > 0 && state.commitSteersThisTurn < cfg.maxCommitSteersPerTurn) {
      try {
        const byRepo = new Map() // repoKey -> { repoRoot, files: Map<relKey, { origKey, relPath }> }
        for (const [origKey, absPath] of state.editedFiles.entries()) {
          if (signal?.aborted) return
          const repoRoot = await findRepoRoot(path.dirname(absPath), signal)
          if (!repoRoot) continue
          const rel = toPosixPath(path.relative(repoRoot, absPath))
          if (!rel || rel === '.' || rel.startsWith('../') || path.isAbsolute(rel)) continue
          const rKey = pathKey(repoRoot)
          let bucket = byRepo.get(rKey)
          if (!bucket) {
            bucket = { repoRoot, files: new Map() }
            byRepo.set(rKey, bucket)
          }
          bucket.files.set(pathKey(rel), { origKey, relPath: rel })
        }

        const dirtyByRepo = new Map()
        for (const bucket of byRepo.values()) {
          if (signal?.aborted) return
          let rawStatus
          try {
            rawStatus = await runGit(['status', '--porcelain', '-z'], bucket.repoRoot, cfg.gitTimeoutMs, signal)
          } catch {
            continue
          }
          const entries = parseStatusPorcelainZ(rawStatus)
          const dirtyRelKeys = new Set()
          const dirtyRelPaths = []

          for (const entry of entries) {
            const entryPosix = toPosixPath(entry.path)
            const entryKey = pathKey(entryPosix)
            if (entry.path.endsWith('/')) {
              const prefix = `${entryKey}/`
              for (const [relKey, info] of bucket.files.entries()) {
                if ((relKey === entryKey || relKey.startsWith(prefix)) && !dirtyRelKeys.has(relKey)) {
                  dirtyRelKeys.add(relKey)
                  dirtyRelPaths.push(info.relPath)
                }
              }
            } else if (bucket.files.has(entryKey) && !dirtyRelKeys.has(entryKey)) {
              dirtyRelKeys.add(entryKey)
              dirtyRelPaths.push(bucket.files.get(entryKey).relPath)
            }
          }

          // Prune files that are now clean in git (committed or reverted)
          for (const [relKey, info] of bucket.files.entries()) {
            if (!dirtyRelKeys.has(relKey)) {
              state.editedFiles.delete(info.origKey)
            }
          }

          if (dirtyRelPaths.length > 0) {
            dirtyRelPaths.sort()
            dirtyByRepo.set(bucket.repoRoot, dirtyRelPaths)
          }
        }

        if (dirtyByRepo.size > 0) {
          const fingerprint = [...dirtyByRepo.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([root, files]) => `${pathKey(root)}::${files.join('|')}`)
            .join('\n')

          if (fingerprint !== state.lastCommitFingerprint && !signal?.aborted) {
            state.commitSteersThisTurn += 1
            state.lastCommitFingerprint = fingerprint
            const { text, summary } = formatCommitSteerMessage(dirtyByRepo)
            agent.steer(createGuardMessage(text, summary))
            return
          }
        }
      } catch (err) {
        ctx.logger.warn(`nervdog-commit-guard: uncommitted check failed (fail-open): ${String(err)}`)
      }
    }

    // 2. Guard pushed commit Continuous CI (only for repos with .claude/scripts/ci-wait.js)
    if (cfg.ciGuard && state.pendingPushChecks.size > 0) {
      await Promise.allSettled([...state.pendingPushChecks])
      if (signal?.aborted) return
    }
    if (cfg.ciGuard && state.pushed && state.pushed.blocks < cfg.maxCiSteersPerPush && state.ciSteersThisTurn < cfg.maxCiSteersPerPush) {
      const pushed = state.pushed
      const ci = loadCiWait(pushed.repoRoot)
      if (!ci) {
        state.pushed = null
        return
      }
      try {
        const res = await ci.look(pushed.sha, pushed.pushedAt)
        if (signal?.aborted) return
        if (!res || res.state === 'green' || res.state === 'none') {
          state.pushed = null
          return
        }
        pushed.blocks += 1
        state.ciSteersThisTurn += 1
        const title = typeof ci.commitTitle === 'function' ? ci.commitTitle(pushed.sha, pushed.repoRoot) : pushed.sha.slice(0, 10)
        const where = res.pipeline ? `#${res.pipeline.id} ${ci.WEB || ''}${res.pipeline.id}` : '（流水线尚未创建）'
        const details = Array.isArray(res.lines) && res.lines.length ? `\n${res.lines.join('\n')}` : ''
        const isRed = res.state === 'red'
        const summary = isRed
          ? `提交守卫：推送提交的 Continuous 变红（${pushed.sha.slice(0, 10)}）`
          : `提交守卫：推送提交的 Continuous 仍在运行（${pushed.sha.slice(0, 10)}）`
        const text = isRed
          ? `<commit-guard>\n你推的「${title}」（${pushed.sha.slice(0, 10)}）的 Continuous 红了：${where}${details}\n按项目第 17 条规矩，没绿不算做完：请修好、提交推送，再运行 \`node .claude/scripts/ci-wait.js\` 等到绿；如果是别人的提交弄红的，查出提交并告诉用户。\n</commit-guard>`
          : `<commit-guard>\n你推的「${title}」（${pushed.sha.slice(0, 10)}）的 Continuous 仍在跑：${where}\n按项目第 17 条规矩，没绿不算做完：请运行 \`node .claude/scripts/ci-wait.js ${pushed.sha.slice(0, 10)}\` 等结果，红了就修好、推送、再等。\n</commit-guard>`
        agent.steer(createGuardMessage(text, summary))
      } catch (err) {
        ctx.logger.warn(`nervdog-commit-guard: CI check failed (fail-open): ${String(err)}`)
      }
    }
  })

  ctx.effect(() => () => {
    stateByRoot.clear()
    parentBySession.clear()
    repoRootCache.clear()
  })
}
