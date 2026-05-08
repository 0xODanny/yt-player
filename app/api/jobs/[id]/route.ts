import { NextResponse } from "next/server";

import { getFakeJobStatus } from "@/lib/jobs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  return NextResponse.json(getFakeJobStatus(id));
}