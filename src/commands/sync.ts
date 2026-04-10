import { Project, SyntaxKind } from "ts-morph";
import fg from "fast-glob";
import chalk from "chalk";
import inquirer from "inquirer";
import {
  loadConfig,
  saveConfig
} from "../utils/config";

export async function sync() {
  let config = await loadConfig();

  if (!config) {
    console.log(
      chalk.red(
        "Run 'eventra init' first"
      )
    );
    return;
  }

  const events = new Set<string>();
  const project = new Project();

  console.log(
    chalk.blue("Scanning project...")
  );

  const files = await fg(
    config.sync.include,
    {
      ignore: config.sync.exclude
    }
  );

  // track()
  for (const file of files) {
    const sourceFile =
      project.addSourceFileAtPath(file);

    const calls =
      sourceFile.getDescendantsOfKind(
        SyntaxKind.CallExpression
      );

    for (const call of calls) {
      const expression =
        call.getExpression();

      if (
        expression.getKind() ===
        SyntaxKind.PropertyAccessExpression
      ) {
        const prop =
          expression.asKind(
            SyntaxKind.PropertyAccessExpression
          );

        if (!prop) continue;

        if (prop.getName() !== "track")
          continue;

        const args =
          call.getArguments();

        const eventArg =
          args[0];

        if (!eventArg) continue;

        let event: string | null = null;

        // "event"
        if (
          eventArg.getKind() ===
          SyntaxKind.StringLiteral
        ) {
          event =
            eventArg
              .asKindOrThrow(
                SyntaxKind.StringLiteral
              )
              .getLiteralText();
        }

        // `event`
        if (
          eventArg.getKind() ===
          SyntaxKind.NoSubstitutionTemplateLiteral
        ) {
          event =
            eventArg
              .asKindOrThrow(
                SyntaxKind.NoSubstitutionTemplateLiteral
              )
              .getLiteralText();
        }

        if (event) {
          events.add(event);
        }
      }
    }
  }

  console.log(
    chalk.green(
      `Found ${events.size} track events`
    )
  );

  // wrappers setup
  if (!config.wrappers.length) {
    const { useWrapper } =
      await inquirer.prompt([
        {
          type: "confirm",
          name: "useWrapper",
          message:
            "Use wrapper components?",
          default: true
        }
      ]);

    if (useWrapper) {
      const wrappers = [];

      let addMore = true;

      while (addMore) {
        const answers =
          await inquirer.prompt([
            {
              type: "input",
              name: "name",
              message:
                "Wrapper component name:"
            },
            {
              type: "input",
              name: "prop",
              message:
                "Event prop name:"
            }
          ]);

        wrappers.push({
          name: answers.name,
          prop: answers.prop
        });

        const more =
          await inquirer.prompt([
            {
              type: "confirm",
              name: "more",
              message:
                "Add another wrapper?",
              default: false
            }
          ]);

        addMore = more.more;
      }

      config.wrappers = wrappers;
    }
  }

  // scan wrappers
  if (config.wrappers.length) {
    console.log(
      chalk.blue(
        "Scanning wrappers..."
      )
    );

    for (const file of files) {
      const sourceFile =
        project.addSourceFileAtPath(file);

      const elements = [
        ...sourceFile.getDescendantsOfKind(
          SyntaxKind.JsxOpeningElement
        ),
        ...sourceFile.getDescendantsOfKind(
          SyntaxKind.JsxSelfClosingElement
        )
      ];

      for (const element of elements) {
        const tagName =
          element
            .getTagNameNode()
            .getText()
            .toLowerCase();

        for (const wrapper of config.wrappers) {
          if (
            tagName !==
            wrapper.name.toLowerCase()
          )
            continue;

          const attrs =
            element.getAttributes();

          for (const attr of attrs) {
            if (
              attr.getKind() !==
              SyntaxKind.JsxAttribute
            )
              continue;

            const attrNode =
              attr.asKind(
                SyntaxKind.JsxAttribute
              );

            if (!attrNode) continue;

            const attrName =
              attrNode
                .getNameNode()
                .getText()
                .toLowerCase();

            if (
              attrName !==
              wrapper.prop.toLowerCase()
            )
              continue;

            const initializer =
              attrNode.getInitializer();

            if (!initializer) continue;

            let value: string | null = null;

            // event="signup"
            if (
              initializer.getKind() ===
              SyntaxKind.StringLiteral
            ) {
              value =
                initializer
                  .asKindOrThrow(
                    SyntaxKind.StringLiteral
                  )
                  .getLiteralText();
            }

            // event={"signup"}
            if (
              initializer.getKind() ===
              SyntaxKind.JsxExpression
            ) {
              const expr =
                initializer
                  .asKindOrThrow(
                    SyntaxKind.JsxExpression
                  )
                  .getExpression();

              if (
                expr?.getKind() ===
                SyntaxKind.StringLiteral
              ) {
                value =
                  expr
                    .asKindOrThrow(
                      SyntaxKind.StringLiteral
                    )
                    .getLiteralText();
              }
            }

            if (value) {
              events.add(value);
            }
          }
        }
      }
    }
  }

  // results
  const list =
    [...events].sort();

  console.log("");

  console.log(
    chalk.green("Found events:")
  );

  list.forEach((e) =>
    console.log(
      chalk.gray(`- ${e}`)
    )
  );

  console.log("");

  // diff
  const previous =
    config.events ?? [];

  const added = list.filter(
    (e) => !previous.includes(e)
  );

  const removed =
    previous.filter(
      (e: string) =>
        !list.includes(e)
    );

  if (added.length || removed.length) {
    console.log(
      chalk.blue("Changes:")
    );

    if (added.length) {
      console.log(
        chalk.green(
          "New events:"
        )
      );

      added.forEach((e) =>
        console.log(
          chalk.green(
            `+ ${e}`
          )
        )
      );
    }

    if (removed.length) {
      console.log(
        chalk.red(
          "Removed events:"
        )
      );

      removed.forEach((e: unknown) =>
        console.log(
          chalk.red(
            `- ${e}`
          )
        )
      );
    }

    console.log("");
  } else {
    console.log(
      chalk.gray(
        "No changes detected"
      )
    );
  }

  // confirm
  const { confirm } =
    await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message:
          "Sync these events?",
        default: true
      }
    ]);

  if (!confirm) {
    console.log(
      chalk.yellow(
        "Sync cancelled"
      )
    );
    return;
  }

  config.events = list;

  await saveConfig(config);

  console.log(
    chalk.green(
      "eventra.json updated"
    )
  );
}
