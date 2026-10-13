/**
 * Mutations made under one `scope` run one after the other, in the order they
 * were made — TanStack Query's `useMutation({ scope: { id } })`. The coach's
 * reorders use it, so that two drags cannot cross on their way to the
 * database. These are the two things such a hook needs.
 */

/**
 * The `scope` option named `<name>-<id>`, or none while the id is not known:
 * a mutation without a scope runs at once, as it always did.
 */
export function mutationScope(name, id) {
  return id ? { id: `${name}-${id}` } : undefined;
}

/**
 * True while another mutation of `scope` is still running or waiting for its
 * turn. Meant for `onSettled`, where the mutation that asks still counts as
 * pending itself — hence "more than one".
 *
 * Why a reorder asks. A drag draws its own order at once (`onMutate` does not
 * wait for the scope), and the next drag sends the FULL list of ids as it
 * reads it off the screen. A refetch started by the first of two drags answers
 * with the order before the second: the row that was just dropped jumps back,
 * and a third drag made at that moment sends a list without the second one —
 * an order nobody chose. So only the last write of a run reads the server
 * again.
 */
export function laterWriteQueued(queryClient, scope) {
  if (!scope?.id) return false;
  return queryClient.isMutating({ predicate: (m) => m.options.scope?.id === scope.id }) > 1;
}
