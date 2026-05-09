import { Command } from "commander";
import { runPull } from "./commands/pull.ts";
import { runList } from "./commands/list.ts";
import { runArchive } from "./commands/archive.ts";
import { buildConfigCommand } from "./commands/config.ts";
import { buildInitCommand } from "./commands/init.ts";
import { buildProjectCommand } from "./commands/project.ts";
import { buildTelemetryCommand } from "./commands/telemetry.ts";
import { buildTicketCommand } from "./commands/ticket.ts";
import { assignTicket } from "./role-pipeline/runner.ts";
import { TICKET_STATES } from "./lib/types.ts";
import pkg from "../package.json" with { type: "json" };

const program = new Command();

program
  .name("oteam")
  .description(
    "Source-agnostic vault-driven role pipeline for spawning Claude agents against tickets",
  )
  .version(pkg.version);

async function handlePull(
  source: string,
  ref: string,
  opts: { vault?: string; project?: string; cloneUri?: string },
): Promise<void> {
  const result = await runPull({
    source,
    ref,
    vault: opts.vault,
    project: opts.project,
    cloneUri: opts.cloneUri,
  });
  const verb = result.reused ? "Reused existing" : "Filed";
  process.stdout.write(`✅ ${verb} ${result.ticketID}\n   ${result.path}\n`);
}

program
  .command("pull <source> <ref>")
  .description(
    "Ingest an external item into the vault as a triage ticket (sources: github)",
  )
  .option("--vault <name-or-path>", "Use a specific registered vault")
  .option(
    "--project <name>",
    "Tag the ticket with a project name (defaults to the source repo's bare name)",
  )
  .option(
    "--clone-uri <url>",
    "Record this clone URI for the repo instead of prompting (daemon-friendly)",
  )
  .action(handlePull);

// `ingest` is the literal verb AC #2 enumerates; `pull` is the user-facing
// verb per AC #8 ("vault pulls, not source pushes") and Spike Decision 5.
// Hidden alias keeps both ACs satisfied without doubling the documented
// surface — `oteam ingest <source> <ref>` runs the same handler as `pull`.
program
  .command("ingest <source> <ref>", { hidden: true })
  .description("Hidden alias for `pull`.")
  .option("--vault <name-or-path>", "Use a specific registered vault")
  .option(
    "--project <name>",
    "Tag the ticket with a project name (defaults to the source repo's bare name)",
  )
  .option(
    "--clone-uri <url>",
    "Record this clone URI for the repo instead of prompting (daemon-friendly)",
  )
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
  .option(
    "--no-stamp",
    "Force a github clone for this run, overriding stamp.enforce in oteam config. The durable knob is 'oteam config stamp set --enforce off'.",
  )
  .action(
    async (
      ticketPath: string,
      opts: { inline?: boolean; vault?: string; stamp?: boolean },
    ) => {
      // commander's `--no-stamp` flag flips `opts.stamp` to `false` (default
      // is `true` because the long form is `--no-stamp`). Translate to the
      // explicit positive `noStamp` field that `assignTicket` consumes.
      await assignTicket({
        ticketPath,
        workInline: opts.inline,
        vault: opts.vault,
        noStamp: opts.stamp === false,
      });
    },
  );

program
  .command("list")
  .description("List tickets in the vault (filter by structured frontmatter or grep)")
  .option("--state <state>", "Filter by ticket state (triage|refined|...)")
  .option("--project <name>", "Filter by project name (case-insensitive)")
  .option("--repo <slug>", "Filter by repo frontmatter (case-insensitive)")
  .option("--team <team>", "Filter by team (case-insensitive)")
  .option("--priority <priority>", "Filter by priority (case-insensitive)")
  .option("--source <type>", "Filter by source.type (github|manual|...)")
  .option(
    "--label <label>",
    "Filter by label (case-insensitive; repeatable, all must match)",
    (value: string, prev: string[] = []) => [...prev, value],
    [] as string[],
  )
  .option(
    "--match <pattern>",
    "Case-insensitive substring match against the title",
  )
  .option(
    "--grep <pattern>",
    "Case-insensitive substring match against the ticket body (reads files)",
  )
  .option(
    "--include-archived",
    "Also search <vault>/archive/ (excluded by default)",
  )
  .option("--vault <name-or-path>", "Use a specific registered vault")
  .action(
    (opts: {
      state?: string;
      project?: string;
      repo?: string;
      team?: string;
      priority?: string;
      source?: string;
      label: string[];
      match?: string;
      grep?: string;
      includeArchived?: boolean;
      vault?: string;
    }) => {
      if (opts.state && !(TICKET_STATES as readonly string[]).includes(opts.state)) {
        process.stderr.write(
          `oteam list: unknown state "${opts.state}" — supported: ${TICKET_STATES.join(", ")}\n`,
        );
        process.exit(2);
      }
      process.stdout.write(runList(opts) + "\n");
    },
  );

program
  .command("archive <ticket-id>")
  .description("Move a done ticket to archive/YYYY-MM/")
  .option("--vault <name-or-path>", "Use a specific registered vault")
  .action((ticketID: string, opts: { vault?: string }) => {
    const path = runArchive({ ticketID, vault: opts.vault });
    process.stdout.write(`✅ Archived\n   ${path}\n`);
  });

program.addCommand(buildConfigCommand());
program.addCommand(buildInitCommand());
program.addCommand(buildProjectCommand());
program.addCommand(buildTelemetryCommand());
program.addCommand(buildTicketCommand());

program.parseAsync(process.argv).catch((err: Error) => {
  process.stderr.write(`oteam: ${err.message}\n`);
  process.exit(1);
});
