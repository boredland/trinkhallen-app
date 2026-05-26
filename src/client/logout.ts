/**
 * Logout island.
 *
 * The service worker uses stale-while-revalidate for navigation requests
 * (see public/sw.js), so a plain `<form action="/auth/logout">` redirect
 * paints the cached logged-in HTML on the next page and only refreshes the
 * cache in the background. The user sees themselves still signed in until
 * the next navigation/reload.
 *
 * This handler intercepts the submit, POSTs the logout, drops the runtime
 * cache, and only then navigates home. Falls back to the plain form behavior
 * if anything goes wrong (so users without JS still get logged out).
 */

export function installLogoutForm(scope: ParentNode = document): void {
  const forms = scope.querySelectorAll<HTMLFormElement>("[data-logout-form]");
  for (const form of forms) {
    if (form.dataset["logoutWired"] === "1") continue;
    form.dataset["logoutWired"] = "1";
    form.addEventListener("submit", onSubmit);
  }
}

async function onSubmit(ev: SubmitEvent): Promise<void> {
  ev.preventDefault();
  const form = ev.currentTarget as HTMLFormElement;
  const submitBtn = form.querySelector<HTMLButtonElement>("button[type='submit']");
  if (submitBtn) submitBtn.disabled = true;
  // Serialize the form so handlers that read fields (e.g. /me/delete with
  // its `confirm=yes` checkbox) actually see them. Previously we POSTed
  // an empty body, which silently failed /me/delete: the handler rejected
  // the un-ticked confirm, returned a redirect we ignored, and the client
  // navigated home as if the deletion succeeded.
  try {
    await fetch(form.action, {
      method: "POST",
      body: new FormData(form),
      redirect: "manual",
    });
  } catch {
    // Fall through to the navigation anyway — the cookie may still be cleared
    // and the next page load will reconcile.
  }
  await purgeRuntimeCache();
  location.replace("/");
}

async function purgeRuntimeCache(): Promise<void> {
  if (!("caches" in self)) return;
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("tk-runtime-")).map((k) => caches.delete(k)));
  } catch {
    // Best-effort — if cache.delete fails, the home reload still hits the
    // network because SWR's revalidate step will already have run by then.
  }
}
