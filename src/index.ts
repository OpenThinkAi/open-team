import { Command } from "commander";
import { runPull } from "./commands/pull.ts";
import { runList } from "./commands/list.ts";
import { runArchive } from "./commands/archive.ts";
import { assignTicket } from "./role-pipeline/runner.ts";
import { runRolePipeline } from "./role-pipeline/role-run.ts";
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

// Hidden alias kept to satisfy AGT-004 AC #2's literal `ingest` wording while
// AC #8 governs the user-facing verb (`pull`). Drop once docs settle.
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

program
  .command("_role-run <ticket-path>", { hidden: true })
  .description("Internal: SDK-native role pipeline run")
  .action(async (ticketPath: string) => {
    await runRolePipeline({ ticketPath });
  });

program.parseAsync(process.argv).catch((err: Error) => {
  process.stderr.write(`oteam: ${err.message}\n`);
  process.exit(1);
});
