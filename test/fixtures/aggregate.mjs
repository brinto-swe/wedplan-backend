import { ObjectId } from "mongodb";

function get(row, path) {
  const [key, ...rest] = path.split(".");
  if (!rest.length) return row?.[key];
  const value = row?.[key];
  return Array.isArray(value) && !/^\d+$/.test(rest[0])
    ? value.map((entry) => get(entry, rest.join(".")))
    : get(value, rest.join("."));
}

function evaluate(expression, row) {
  if (typeof expression === "string" && expression.startsWith("$")) return get(row, expression.slice(1));
  if (!expression || typeof expression !== "object" || expression instanceof Date) return expression;
  const [[op, arg]] = Object.entries(expression);
  if (!op.startsWith("$")) return Object.fromEntries(Object.entries(expression).map(([key, value]) => [key, evaluate(value, row)]));
  if (op === "$type") {
    const value = evaluate(arg, row);
    return value instanceof Date ? "date" : value === undefined ? "missing" : typeof value;
  }
  if (op === "$convert") {
    const value = evaluate(arg.input, row);
    return ObjectId.isValid(value) ? new ObjectId(value) : null;
  }
  if (op === "$size") return evaluate(arg, row).length;
  const [a, b, c] = arg.map((operand) => evaluate(operand, row));
  switch (op) {
    case "$eq": return a === b;
    case "$gt": return a > b;
    case "$lte": return a <= b;
    case "$in": return b.includes(a);
    case "$or": return arg.some((operand) => evaluate(operand, row));
    case "$and": return arg.every((operand) => evaluate(operand, row));
    case "$cond": return a ? b : c;
    default: throw new Error("Unexpected expression " + op);
  }
}

export function matches(row, filter) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$or") return condition.some((branch) => matches(row, branch));
    const value = get(row, key);
    if (condition instanceof ObjectId) return condition.equals(value);
    if (condition instanceof RegExp) return condition.test(value);
    if (condition === null) return value == null;
    if (typeof condition !== "object") return value === condition;
    return Object.entries(condition).every(([op, operand]) => {
      switch (op) {
        case "$in": return operand.includes(value);
        case "$nin": return !operand.includes(value);
        case "$ne": return value !== operand;
        case "$gt": return value instanceof Date && value > operand;
        case "$type": return typeof value === operand;
        case "$exists": return (value !== undefined) === operand;
        default: throw new Error("Unexpected filter " + op);
      }
    });
  });
}

function sortRows(rows, sort) {
  return [...rows].sort((left, right) => {
    for (const [key, direction] of Object.entries(sort)) {
      const a = left[key]?.valueOf();
      const b = right[key]?.valueOf();
      if (String(a) === String(b)) continue;
      if (a < b) return -direction;
      if (a > b) return direction;
    }
    return 0;
  });
}

export function aggregate(source, pipeline, collections) {
  let rows = source;
  for (const stage of pipeline) {
    if (stage.$match) rows = rows.filter((row) => matches(row, stage.$match));
    else if (stage.$set) rows = rows.map((row) => ({
      ...row, ...Object.fromEntries(Object.entries(stage.$set).map(([key, value]) => [key, evaluate(value, row)])),
    }));
    else if (stage.$lookup) {
      const { as, from, localField, foreignField, pipeline: inner } = stage.$lookup;
      rows = rows.map((row) => ({
        ...row, [as]: aggregate(collections[from].filter((foreign) =>
          row[localField]?.equals(foreign[foreignField])), inner, collections),
      }));
    } else if (stage.$project) rows = rows.map((row) =>
      Object.fromEntries(Object.entries(stage.$project).map(([key, rule]) => [key, rule === 1 ? row[key] : evaluate(rule, row)])));
    else if (stage.$unset) rows = rows.map((row) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => !stage.$unset.includes(key))));
    else if (stage.$setWindowFields) {
      const { partitionBy, sortBy, output } = stage.$setWindowFields;
      const partitions = new Map();
      rows = sortRows(rows, sortBy).map((row) => {
        const key = JSON.stringify(evaluate(partitionBy, row));
        const position = (partitions.get(key) ?? 0) + 1;
        partitions.set(key, position);
        return { ...row, [Object.keys(output)[0]]: position };
      });
    } else if (stage.$facet) rows = [Object.fromEntries(Object.entries(stage.$facet).map(([key, inner]) =>
      [key, aggregate(rows, inner, collections)]))];
    else if (stage.$skip !== undefined) rows = rows.slice(stage.$skip);
    else if (stage.$limit !== undefined) rows = rows.slice(0, stage.$limit);
    else if (stage.$count) rows = rows.length ? [{ [stage.$count]: rows.length }] : [];
    else if (stage.$sort) rows = sortRows(rows, stage.$sort);
    else if (stage.$group) {
      const { _id, ...fields } = stage.$group;
      const groups = new Map();
      for (const row of rows) {
        const id = evaluate(_id, row);
        const total = groups.get(id) ?? { _id: id };
        for (const [key, { $sum }] of Object.entries(fields)) {
          total[key] = (total[key] ?? 0) + evaluate($sum, row);
        }
        groups.set(id, total);
      }
      rows = [...groups.values()];
    } else throw new Error("Unexpected aggregation stage");
  }
  return rows;
}
