import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    items: [],
    message: "Downloads endpoint placeholder for future local file listing.",
  });
}