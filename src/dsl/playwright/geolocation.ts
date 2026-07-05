/**
 * playwright/geolocation.ts — Geolocation emulation and browser permission steps.
 *
 * Uses Playwright's `BrowserContext.setGeolocation()` and
 * `BrowserContext.grantPermissions()` / `clearPermissions()`.
 *
 * Supported patterns:
 *   I set geolocation to latitude "<lat>" longitude "<lng>"
 *   I set geolocation to latitude "<lat>" longitude "<lng>" accuracy "<m>"
 *   I clear geolocation
 *   I grant permission "<permissionName>"
 *   I grant permissions "<p1>, <p2>, ..."
 *   I deny permission "<permissionName>"
 *   I clear permissions
 */

import type { DslRegistry } from '../registry';
import type { PageLike } from '../locatorUtils';

export function registerGeolocation(registry: DslRegistry): void {

  // I set geolocation to latitude "<lat>" longitude "<lng>" accuracy "<m>"
  // Registered before the 2-param version (first-match wins).
  registry.register(
    /^I set geolocation to latitude "([^"]+)" longitude "([^"]+)" accuracy "([^"]+)"$/i,
    async ([lat, lng, accuracy], scope, page) => {
      const coords = {
        latitude: parseFloat(lat!),
        longitude: parseFloat(lng!),
        accuracy: parseFloat(accuracy!),
      };
      await (page as PageLike).context().setGeolocation(coords);
      scope.set('pgwen.geolocation.latitude', lat!);
      scope.set('pgwen.geolocation.longitude', lng!);
      scope.set('pgwen.geolocation.accuracy', accuracy!);
    }
  );

  // I set geolocation to latitude "<lat>" longitude "<lng>"
  registry.register(
    /^I set geolocation to latitude "([^"]+)" longitude "([^"]+)"$/i,
    async ([lat, lng], scope, page) => {
      const coords = {
        latitude: parseFloat(lat!),
        longitude: parseFloat(lng!),
      };
      await (page as PageLike).context().setGeolocation(coords);
      scope.set('pgwen.geolocation.latitude', lat!);
      scope.set('pgwen.geolocation.longitude', lng!);
    }
  );

  // I clear geolocation
  registry.register(
    /^I clear geolocation$/i,
    async (_, scope, page) => {
      await (page as PageLike).context().setGeolocation({ latitude: 0, longitude: 0 });
      scope.set('pgwen.geolocation.latitude', '0');
      scope.set('pgwen.geolocation.longitude', '0');
    }
  );

  // I grant permission "<permissionName>"
  registry.register(
    /^I grant permission "([^"]+)"$/i,
    async ([permission], _scope, page) => {
      await (page as PageLike).context().grantPermissions([permission!.trim()]);
    }
  );

  // I grant permissions "<p1>, <p2>, ..."  (comma-separated list)
  registry.register(
    /^I grant permissions "([^"]+)"$/i,
    async ([permissions], _scope, page) => {
      const list = permissions!.split(',').map(p => p.trim()).filter(Boolean);
      await (page as PageLike).context().grantPermissions(list);
    }
  );

  // I deny permission "<permissionName>"  (deny = revoke by clearing then re-granting others)
  registry.register(
    /^I deny permission "([^"]+)"$/i,
    async ([_permission], _scope, page) => {
      // Playwright doesn't support granular revoke — clear all permissions
      await (page as PageLike).context().clearPermissions();
    }
  );

  // I clear permissions
  registry.register(
    /^I clear permissions$/i,
    async (_, _scope, page) => {
      await (page as PageLike).context().clearPermissions();
    }
  );
}
