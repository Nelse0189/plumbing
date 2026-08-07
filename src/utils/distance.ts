export function haversineMiles(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Sort farthest from origin first; equal distance keeps relative order. */
export function sortFarthestFirst<T extends { distanceMiles?: number | null; priority?: number }>(
  stops: T[]
): T[] {
  return [...stops].sort((left, right) => {
    const priorityDelta = (right.priority ?? 0) - (left.priority ?? 0);
    if (priorityDelta !== 0) return priorityDelta;
    const leftDistance = left.distanceMiles ?? -1;
    const rightDistance = right.distanceMiles ?? -1;
    return rightDistance - leftDistance;
  });
}
