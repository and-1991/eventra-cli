// src/compiler/importGraph.ts

export class ImportGraph {

  // file -> imports

  private readonly imports =
    new Map<string, Set<string>>();

  // import -> importers

  private readonly reverse =
    new Map<string, Set<string>>();

  updateFile(
    file: string,
    nextImports:
    readonly string[]
  ): void {

    const previous =
      this.imports.get(file)
      ?? new Set<string>();

    const next =
      new Set(nextImports);

    // remove old edges

    for (
      const imported
      of previous
      ) {

      if (
        next.has(imported)
      ) {

        continue;
      }

      const reverseImporters =
        this.reverse.get(
          imported
        );

      if (
        reverseImporters
      ) {

        reverseImporters.delete(
          file
        );

        if (
          reverseImporters.size
          === 0
        ) {

          this.reverse.delete(
            imported
          );
        }
      }
    }

    // add new edges

    for (
      const imported
      of next
      ) {

      if (
        previous.has(imported)
      ) {

        continue;
      }

      let importers =
        this.reverse.get(
          imported
        );

      if (!importers) {

        importers =
          new Set<string>();

        this.reverse.set(
          imported,
          importers
        );
      }

      importers.add(file);
    }

    this.imports.set(
      file,
      next
    );
  }

  removeFile(
    file: string
  ): void {

    const imports =
      this.imports.get(file);

    if (imports) {

      for (
        const imported
        of imports
        ) {

        const importers =
          this.reverse.get(
            imported
          );

        if (
          importers
        ) {

          importers.delete(file);

          if (
            importers.size
            === 0
          ) {

            this.reverse.delete(
              imported
            );
          }
        }
      }
    }

    this.imports.delete(file);

    this.reverse.delete(file);

    for (
      const importers
      of this.reverse.values()
      ) {

      importers.delete(file);
    }
  }

  collectDependents(
    file: string
  ): Set<string> {

    const result =
      new Set<string>();

    const queue = [file];

    while (queue.length) {

      const current =
        queue.pop()!;

      if (
        result.has(current)
      ) {

        continue;
      }

      result.add(current);

      const importers =
        this.reverse.get(
          current
        );

      if (!importers) {
        continue;
      }

      for (
        const importer
        of importers
        ) {

        queue.push(importer);
      }
    }

    return result;
  }
}
