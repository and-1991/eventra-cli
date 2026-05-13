// src/analysis/scanner/sinkDetector.ts

import ts from "typescript";

import {
  TrackSink,
  TrackedArgument,
} from "../shared/propagation";

function isElementTrackProperty(
  expr:
  ts.Expression,
): boolean {

  return (
    ts.isElementAccessExpression(
      expr,
    )
    && expr.argumentExpression
    && ts.isStringLiteral(
      expr.argumentExpression,
    )
    && expr.argumentExpression.text
    === "track"
  );
}

function isTrackIdentifier(
  expr:
  ts.Expression,
): boolean {

  return (
    ts.isIdentifier(expr)
    && expr.text === "track"
  );
}

function isTrackProperty(
  expr:
  ts.Expression,
): boolean {

  return (
    ts.isPropertyAccessExpression(
      expr,
    )
    && expr.name.text
    === "track"
  );
}

function isOptionalTrackProperty(
  expr:
  ts.Expression,
): boolean {

  return (
    ts.isPropertyAccessChain(
      expr,
    )
    && expr.name.text
    === "track"
  );
}

function extractTrackedArguments(
  call:
  ts.CallExpression,
): readonly TrackedArgument[] {

  const result:
    TrackedArgument[] = [];

  if (
    call.arguments.length
    === 0
  ) {

    return result;
  }

  //
  // ONLY FIRST ARGUMENT
  // IS EVENT SINK
  //
  // track(name, payload)
  //       ^^^^
  //

  const first =
    call.arguments[0];

  //
  // track({
  //   event: "signup"
  // })
  //

  if (
    ts.isObjectLiteralExpression(
      first,
    )
  ) {

    for (
      const property
      of first.properties
      ) {

      if (
        !ts.isPropertyAssignment(
          property,
        )
      ) {

        continue;
      }

      const name =
        property.name
          .getText();

      if (
        name !== "event"
        && name !== "name"
        && name !== "type"
      ) {

        continue;
      }

      result.push({

        index: 0,

        propertyPath: [
          name,
        ],
      });
    }

    return result;
  }

  //
  // track(name)
  //

  result.push({

    index: 0,

    propertyPath: [],
  });

  return result;
}

export function detectTrackSink(
  call:
  ts.CallExpression,
): TrackSink | null {

  const expression =
    call.expression;

  if (
    !isTrackIdentifier(
      expression,
    )
    && !isTrackProperty(
      expression,
    )
    && !isOptionalTrackProperty(
      expression,
    )
    && !isElementTrackProperty(
      expression,
    )
  ) {

    return null;
  }

  return {

    call,

    trackedArguments:
      extractTrackedArguments(
        call,
      ),
  };
}
