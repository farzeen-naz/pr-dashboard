import { NextResponse } from "next/server";
import { upsertSeen } from "@/lib/db";
import type { CiState } from "@/lib/types";

export const dynamic = "force-dynamic";

type Body = {
  prId?: string;
  reviewsCount?: number;
  commentsCount?: number;
  ciState?: CiState;
  wasReviewRequested?: boolean;
  isMerged?: boolean;
};

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body.prId || typeof body.prId !== "string") {
    return NextResponse.json({ error: "prId is required" }, { status: 400 });
  }

  upsertSeen({
    prId: body.prId,
    reviewsCount: body.reviewsCount ?? 0,
    commentsCount: body.commentsCount ?? 0,
    ciState: body.ciState ?? null,
    wasReviewRequested: !!body.wasReviewRequested,
    isMerged: !!body.isMerged,
  });

  return NextResponse.json({ ok: true });
}
