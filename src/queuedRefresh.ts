/** Ejecuta una consulta a la vez y recoge los avisos recibidos durante ella. */
export function queuedRefresh<T>(
  load: () => Promise<T>,
  update: (value: T) => void,
  fail: (error: unknown) => void,
) {
  let active = true;
  let pending = false;
  let repeat = false;

  const refresh = async () => {
    if (!active) return;
    if (pending) {
      repeat = true;
      return;
    }
    pending = true;
    try {
      do {
        repeat = false;
        try {
          const value = await load();
          if (active) update(value);
        } catch (error) {
          if (active) fail(error);
        }
      } while (active && repeat);
    } finally {
      pending = false;
    }
  };

  return { refresh, stop: () => { active = false; } };
}
