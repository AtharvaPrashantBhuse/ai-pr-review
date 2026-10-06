import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const repositories = await prisma.repository.findMany({
      orderBy: {
        id: "asc",
      },
    });

    return NextResponse.json(repositories);
  } catch (error) {
    console.error("Failed to fetch repositories:", error);

    return NextResponse.json(
      { error: "Failed to fetch repositories" },
      { status: 500 }
    );
  }
}