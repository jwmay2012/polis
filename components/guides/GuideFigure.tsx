import Image from 'next/image';
import type { ReactNode } from 'react';
import setupLink from '../../public/guides/setup-link.png';
import customerOIDC from '../../public/guides/customer-oidc.png';
import customerSAML from '../../public/guides/customer-saml.png';
import membership from '../../public/guides/application-membership.png';
import pilot from '../../public/guides/pilot-routing.png';
import move from '../../public/guides/move-confirmation.png';

const images = { setupLink, customerOIDC, customerSAML, membership, pilot, move };

export function GuideFigure({
  image,
  alt,
  children,
}: {
  image: keyof typeof images;
  alt: string;
  children: ReactNode;
}) {
  return (
    <figure className='my-6 rounded border border-gray-200 p-3'>
      <Image
        src={images[image]}
        alt={alt}
        sizes='(max-width: 1024px) 100vw, 900px'
        className='my-0 w-full'
        style={{ height: 'auto' }}
      />
      <figcaption className='mt-3 text-sm text-gray-600'>{children}</figcaption>
    </figure>
  );
}
