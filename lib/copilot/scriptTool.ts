/**
 * emit_parts_script — the copilot's programmable placement tool.
 *
 * The model writes JavaScript; we run it in a QuickJS WASM sandbox (no
 * Node APIs, no network, hard time/memory caps). The script calls
 * place(part, color, x, z, opts?) to emit placements; every emitted
 * placement then goes through the exact same validation as manual
 * placement (known part, inventory, collision).
 */
import { getQuickJS } from "quickjs-emscripten";
import type { PlacementInput } from "./state";

const MAX_PLACEMENTS = 2000;
const MAX_MS = 2000;

export interface ScriptResult {
  placements: PlacementInput[];
  logs: string[];
  error: string | null;
}

export async function runPartsScript(code: string): Promise<ScriptResult> {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  const deadline = Date.now() + MAX_MS;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const vm = runtime.newContext();

  const placements: PlacementInput[] = [];
  const logs: string[] = [];
  let error: string | null = null;

  try {
    // place(part, color, x_stud, z_stud, opts?) — opts: {rot, y}
    const placeFn = vm.newFunction("place", (partH, colorH, xH, zH, optsH) => {
      if (placements.length >= MAX_PLACEMENTS) {
        return; // silently cap; reported in summary
      }
      const opts = optsH ? (vm.dump(optsH) as { rot?: number; y?: number } | null) : null;
      placements.push({
        part: String(vm.dump(partH)),
        color: Number(vm.dump(colorH)),
        x_stud: Number(vm.dump(xH)),
        z_stud: Number(vm.dump(zH)),
        rot: (opts?.rot ?? 0) as PlacementInput["rot"],
        y_ldu: opts?.y,
      });
    });
    vm.setProp(vm.global, "place", placeFn);
    placeFn.dispose();

    const logFn = vm.newFunction("log", (msgH) => {
      if (logs.length < 20) logs.push(String(vm.dump(msgH)));
    });
    vm.setProp(vm.global, "log", logFn);
    logFn.dispose();

    const result = vm.evalCode(code);
    if (result.error) {
      const e = vm.dump(result.error) as { name?: string; message?: string };
      error = `${e?.name ?? "Error"}: ${e?.message ?? "script failed"}`;
      result.error.dispose();
    } else {
      result.value.dispose();
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    vm.dispose();
    runtime.dispose();
  }

  return { placements, logs, error };
}
