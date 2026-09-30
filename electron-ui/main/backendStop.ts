// The order the desktop shell stops the backend it spawned on quit.
//
// No Electron import, so this runs under plain node/tsx -- see
// ./backendStop.test.ts, the same arrangement as ./downloadNaming.ts.
//
// POST /api/admin/shutdown makes the backend run its shutdown handlers before it
// exits (backend/admin_routes.py): the live VST hosts, each of which saves its
// plugin state, then the background queue, the assistant's claude children and
// every sidecar. Those handlers get SHUTDOWN_HANDLER_BUDGET_SEC (15 s) after a
// 0.6 s pause. A force-kill inside that window cuts the plugin saves off, so the
// shell waits out the whole budget once the backend has accepted the request,
// and kills at once only when the request is refused or never answered.

/** How long an accepted shutdown gets before the process tree is killed:
 *  admin_routes' 0.6 s pause plus its 15 s handler budget, with a margin. */
export const BACKEND_SHUTDOWN_GRACE_MS = 17_000

/** How long the kill itself gets before quit goes ahead regardless. */
export const BACKEND_KILL_WAIT_MS = 3_000

export interface BackendStopper {
  /** Sends POST /api/admin/shutdown; true only when the backend accepted it. */
  requestShutdown(): Promise<boolean>
  /** Registers a listener for the backend process's exit. */
  onExit(listener: () => void): void
  /** Kills the backend's whole process tree; resolves once the kill has run. */
  forceKill(): Promise<void>
  log(line: string): void
}

/** 'exited': the backend exited by itself. 'killed': it was force-killed.
 *  'deadline': neither finished in time and quit goes ahead anyway. */
export type BackendStopOutcome = 'exited' | 'killed' | 'deadline'

export function stopBackend(
  stopper: BackendStopper,
  graceMs: number = BACKEND_SHUTDOWN_GRACE_MS,
  killWaitMs: number = BACKEND_KILL_WAIT_MS,
): Promise<BackendStopOutcome> {
  return new Promise((resolve) => {
    let settled = false
    let killing = false
    const timers: ReturnType<typeof setTimeout>[] = []

    const settle = (outcome: BackendStopOutcome): void => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      resolve(outcome)
    }

    const kill = (why: string): void => {
      if (settled || killing) return
      killing = true
      stopper.log(why)
      // The quit can never wait longer than the kill's own allowance.
      timers.push(setTimeout(() => settle('deadline'), killWaitMs))
      stopper.forceKill().then(
        () => settle('killed'),
        () => settle('killed'),
      )
    }

    stopper.onExit(() => {
      stopper.log('Backend process terminated.')
      settle('exited')
    })

    stopper.requestShutdown().then(
      (accepted) => {
        if (settled) return
        if (accepted) {
          stopper.log('Backend accepted the shutdown request; waiting for its shutdown handlers.')
          timers.push(
            setTimeout(
              () => kill('Backend did not exit within its shutdown budget - force-killing its tree...'),
              graceMs,
            ),
          )
        } else {
          kill('Backend refused the shutdown request - force-killing its tree...')
        }
      },
      () => kill('Shutdown endpoint unreachable - force-killing the backend tree...'),
    )
  })
}
