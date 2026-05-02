import { Command } from "commander";
import { runPull } from "./commands/pull.ts";
import { runList } from "./commands/list.ts";
import { runArchive } from "./commands/archive.ts";
import { assignTicket } from "./role-pipeline/runner.ts";
import { TICKET_STATES } from "./lib/types.ts";

const program = new Command();

program
  .name("oteam")
  .description(
    "Source-agnostic vault-driven role pipeline for spawning Claude agents against tickets",
  )
  .version("0.0.1");

async function handlePull(source: string, ref: string): Promise<void> {
  const result = await runPull({ source, ref });
  const verb = result.reused ? "Reused existing" : "Filed";
  process.stdout.write(`✅ ${verb} ${result.ticketID}\n   ${result.path}\n`);
}

program
  .command("pull <source> <ref>")
  .description(
    "Ingest an external item into the vault as a triage ticket (sources: github)",
  )
  .action(handlePull);

// `ingest` is the literal verb AC #2 enumerates; `pull` is the user-facing
// verb per AC #8 ("vault pulls, not source pushes") and Spike Decision 5.
// Hidden alias keeps both ACs satisfied without doubling the documented
// surface — `oteam ingest <source> <ref>` runs the same handler as `pull`.
program
  .command("ingest <source> <ref>", { hidden: true })
  .description("Hidden alias for `pull`.")
  .action(handlePull);

program
  .command("assign <ticket-path>")
  .description(
    "Drive the role pipeline against a ticket file (spawns kitty on macOS)",
  )
  .option(
    "--inline",
    "Run the role pipeline in the current terminal instead of spawning kitty",
  )
  .action(async (ticketPath: string, opts: { inline?: boolean }) => {
    await assignTicket({ ticketPath, workInline: opts.inline });
  });

program
  .command("list")
  .description("List active tickets")
  .option("--state <state>", "Filter by ticket state (triage|refined|...)")
  .action((opts: { state?: string }) => {
    if (opts.state && !(TICKET_STATES as readonly string[]).includes(opts.state)) {
      process.stderr.write(
        `oteam list: unknown state "${opts.state}" — supported: ${TICKET_STATES.join(", ")}\n`,
      );
      process.exit(2);
    }
    process.stdout.write(runList(opts) + "\n");
  });

program
  .command("archive <ticket-id>")
  .description("Move a done ticket to archive/YYYY-MM/")
  .action((ticketID: string) => {
    const path = runArchive({ ticketID });
    process.stdout.write(`✅ Archived\n   ${path}\n`);
  });

program.parseAsync(process.argv).catch((err: Error) => {
  process.stderr.write(`oteam: ${err.message}\n`);
  process.exit(1);
});
