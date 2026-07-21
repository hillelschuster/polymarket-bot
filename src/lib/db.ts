import { PrismaClient } from "@prisma/client";

// Single Prisma client instance for the whole app (jobs + dashboard).
export const prisma = new PrismaClient();
