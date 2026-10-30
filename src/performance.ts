// Opt-in diagnostics, stderr only; never emits transcript text or file paths.
export function measure(name: string): (counts?: Record<string, number>) => void {
  if (process.env.QUANTUM_WATCHER_PROFILE !== '1') return () => {}
  const start = performance.now()
  const cpu = process.cpuUsage()
  return (counts = {}) => {
    const used = process.cpuUsage(cpu)
    process.stderr.write(JSON.stringify({ phase: name, wallMs: performance.now() - start,
      cpuMs: (used.user + used.system) / 1000, ...counts }) + '\n')
  }
}
