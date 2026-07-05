/**
 * actions/process.ts — System process execution steps.
 *
 * Executes shell commands using Node.js `child_process.execSync`.
 * Stdout is trimmed and stored in scope when the "capture" variant is used.
 *
 * Supported patterns (all the reference framework-parity aliases supported):
 *   I execute the system process "<command>"
 *   I execute unix system process "<command>"
 *   I execute the system process "<command>" and capture the output as <name>
 *   I execute unix system process "<command>" and capture the output as <name>
 *
 * Doc string form (multi-line commands):
 *   I execute unix system process
 *       """
 *       curl --silent \
 *            --request POST ...
 *       """
 *
 * For the doc string form, the command is read from scope key `pgwen._step_docstring`
 * which Compositor sets before calling the handler when a doc string is present.
 */

import { execSync } from 'child_process';
import type { DslRegistry } from '../registry';

export function registerProcessActions(registry: DslRegistry): void {

  // Capture variants — must be registered BEFORE plain execute (first-match wins).

  // I execute [unix] [the] system process "<command>" and capture the output as <name>
  registry.register(
    /^I execute (?:unix )?(?:the )?system process "([^"]+)" and capture the output as (.+)$/i,
    async ([command, name], scope) => {
      const output = execSync(command!, { encoding: 'utf-8' }).trimEnd();
      scope.set(name!.trim(), output);
    }
  );

  // Plain execute variants — quoted command.

  // I execute [unix] [the] system process "<command>" delimited by "<delim>"
  // The delimiter clause is honoured by the binding form (text.ts) but for the
  // action form the output is discarded — delimited is accepted for syntactic
  // parity so the same step text works in both contexts.
  registry.register(
    /^I execute (?:unix )?(?:the )?system process "([^"]+)" delimited by "([^"]+)"$/i,
    async ([command]) => {
      execSync(command!, { encoding: 'utf-8' });
    }
  );

  // I execute [unix] [the] system process "<command>"
  registry.register(
    /^I execute (?:unix )?(?:the )?system process "([^"]+)"$/i,
    async ([command]) => {
      execSync(command!, { encoding: 'utf-8' });
    }
  );

  // Doc string form — no quoted argument; command comes from pgwen._step_docstring set by Compositor.

  // I execute unix system process   (doc string body)
  // I execute the system process    (doc string body)
  // I execute system process        (doc string body)
  registry.register(
    /^I execute (?:unix )?(?:the )?system process$/i,
    async (_groups, scope) => {
      const command = scope.get('pgwen._step_docstring') ?? '';
      if (!command) {
        throw new Error(
          'I execute system process: no command provided — use a quoted argument or a doc string (""") block'
        );
      }
      execSync(command.trim(), { encoding: 'utf-8' });
    }
  );

  // Doc string form with capture.
  // I execute unix system process and capture the output as <name>  (doc string body)
  registry.register(
    /^I execute (?:unix )?(?:the )?system process and capture the output as (.+)$/i,
    async ([name], scope) => {
      const command = scope.get('pgwen._step_docstring') ?? '';
      if (!command) {
        throw new Error(
          'I execute system process and capture: no command provided — use a quoted argument or a doc string (""") block'
        );
      }
      const output = execSync(command.trim(), { encoding: 'utf-8' }).trimEnd();
      scope.set(name!.trim(), output);
    }
  );
}

