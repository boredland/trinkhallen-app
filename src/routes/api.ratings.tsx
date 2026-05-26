import { Hono } from "hono";
import { RatingBlock } from "../components/RatingBlock";
import type { Env } from "../env";
import { getKioskById } from "../lib/asset-kiosks";
import {
  deleteRating,
  getAggregate,
  getOwnRating,
  listComments,
  upsertRating,
} from "../lib/ratings";

export const apiRatings = new Hono<{ Bindings: Env }>();

apiRatings.post("/api/ratings", async (c) => {
  const user = c.get("user");
  if (!user) return c.text("Bitte anmelden.", 401);

  const form = await c.req.formData();
  const kioskId = (form.get("kiosk_id") ?? "").toString();
  const starsRaw = parseInt((form.get("stars") ?? "").toString(), 10);
  const comment = (form.get("comment") ?? "").toString().trim() || null;

  if (!kioskId) return c.text("kiosk_id missing", 400);
  if (!Number.isInteger(starsRaw) || starsRaw < 1 || starsRaw > 5) {
    return c.text("stars must be 1..5", 400);
  }

  const kiosk = await getKioskById(c.env, kioskId);
  if (!kiosk) return c.text("kiosk not found", 404);

  await upsertRating(c.env, {
    kioskId,
    userId: user.id,
    stars: starsRaw,
    comment: comment && comment.length <= 500 ? comment : null,
  });

  return renderFragmentOrRedirect(c, kioskId, user.id);
});

apiRatings.post("/api/ratings/delete", async (c) => {
  const user = c.get("user");
  if (!user) return c.text("Bitte anmelden.", 401);
  const form = await c.req.formData();
  const kioskId = (form.get("kiosk_id") ?? "").toString();
  if (!kioskId) return c.text("kiosk_id missing", 400);
  await deleteRating(c.env, kioskId, user.id);
  return renderFragmentOrRedirect(c, kioskId, user.id);
});

async function renderFragmentOrRedirect(
  c: import("hono").Context<{ Bindings: Env }>,
  kioskId: string,
  userId: string,
) {
  // Client island sends `X-Tk-Fragment: 1` and swaps `#rating-block` in place.
  // A plain form submit (no JS) lacks the header and falls through to the
  // redirect so the full kiosk page re-renders with the new rating.
  const wantsFragment = c.req.header("X-Tk-Fragment") === "1";
  const [aggregate, own, comments] = await Promise.all([
    getAggregate(c.env, kioskId),
    getOwnRating(c.env, kioskId, userId),
    listComments(c.env, kioskId),
  ]);
  if (wantsFragment) {
    return c.html(
      <RatingBlock
        kioskId={kioskId}
        aggregate={aggregate}
        own={own}
        comments={comments}
        isLoggedIn={true}
      />,
    );
  }
  return c.redirect(`/k/${kioskId}`);
}
