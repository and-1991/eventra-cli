export class SemanticDependencyGraph {

  private readonly dependencies =
    new Map<
      string,
      Set<string>
    >();

  addDependency(
    from: string,
    to: string,
  ): void {

    let deps =
      this.dependencies.get(
        from,
      );

    if (!deps) {

      deps =
        new Set();

      this.dependencies.set(
        from,
        deps,
      );
    }

    deps.add(to);
  }

  getDependents(
    file: string,
  ): Set<string> {

    const result =
      new Set<string>();

    for (
      const [
        from,
        deps,
      ]
      of this.dependencies
      ) {

      if (
        deps.has(file)
      ) {

        result.add(from);
      }
    }

    return result;
  }
}
