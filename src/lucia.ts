import { Lucia } from "lucia";
import { PrismaAdapter } from "@lucia-auth/adapter-prisma";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const lucia = new Lucia(
  new PrismaAdapter(prisma.session, prisma.users),
  {
    sessionCookie: {
      name: 'auth_session',
      expires: false,
      attributes: {
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/'
      }
    },
    getUserAttributes: (user: any) => ({
      id: user.id,
      email: user.email,
      role: user.role
    })
  }
);

export type Auth = typeof lucia; 