import { Command } from "commander";
import { runPull } from "./commands/pull.ts";
import { runList } from "./commands/list.ts";
import { runArchive } from "./commands/archive.ts";
import { buildConfigCommand } from "./commands/config.ts";
import { assignTicket } from "./role-pipeline/runner.ts";
import { TICKET_STATES } from "./lib/types.ts";

const program = new Command();

program
  .name("oteam")
  .description(
    "Source-agnostic vault-driven role pipeline for spawning Claude agents against tickets",
  )
  .version("0.0.1");

async function handlePull(
  source: string,
  ref: string,
  opts: { vault?: string },
): Promise<void> {
  const result = await runPull({ source, ref, vault: opts.vault });
  const verb = result.reused ? "Reused existing" : "Filed";
  process.stdout.write(`✅ ${verb} ${result.ticketID}\n   ${result.path}\n`);
}

program
  .command("pull <source> <ref>")
  .description(
    "Ingest an external item into the vault as a triage ticket (sources: github)",
  )
  .option("--vault <name-or-path>", "Use a specific registered vault")
  .action(handlePull);

// `ingest` is the literal verb AC #2 enumerates; `pull` is the user-facing
// verb per AC #8 ("vault pulls, not source pushes") and Spike Decision 5.
// Hidden alias keeps both ACs satisfied without doubling the documented
// surface — `oteam ingest <source> <ref>` runs the same handler as `pull`.
program
  .command("ingest <source> <ref>", { hidden: true })
  .description("Hidden alias for `pull`.")
  .option("--vault <name-or-path>", "Use a specific registered vault")
  .action(handlePull);

program
  .command("assign <ticket-or-id>")
  .description(
    "Drive the role pipeline against a ticket (full path or AGT-NNN id)",
  )
  .option(
    "--inline",
    "Run the role pipeline in the current terminal instead of spawning kitty",
  )
  .option("--vault <name-or-path>", "Use a specific registered vault")
  .action(
    async (
      ticketPath: string,
      opts: { inline?: boolean; vault?: string },
    ) => {
      await assignTicket({
        ticketPath,
        workInline: opts.inline,
        vault: opts.vault,
      });
    },
  );

program
  .command("list")
  .description("List active tickets")
  .option("--state <state>", "Filter by ticket state (triage|refined|...)")
  .option("--vault <name-or-path>", "Use a specific registered vault")
  .action((opts: { state?: string; vault?: string }) => {
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
  .option("--vault <name-or-path>", "Use a specific registered vault")
  .action((ticketID: string, opts: { vault?: string }) => {
    const path = runArchive({ ticketID, vault: opts.vault });
    process.stdout.write(`✅ Archived\n   ${path}\n`);
  });

program.addCommand(buildConfigCommand());

program.parseAsync(process.argv).catch((err: Error) => {
  process.stderr.write(`oteam: ${err.message}\n`);
  process.exit(1);
});
