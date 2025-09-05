"use client";

import { useState } from "react";
import { X, ZoomIn } from "lucide-react";

interface ImageViewerProps {
  src: string;
  alt?: string;
  className?: string;
  thumbnailUrl?: string;
}

export function ImageViewer({ src, alt = "", className = "", thumbnailUrl }: ImageViewerProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);

  const displaySrc = thumbnailUrl || src;

  const handleClick = () => {
    console.log('ImageViewer clicked!', { src, displaySrc, thumbnailUrl });
    setIsModalOpen(true);
  };

  return (
    <>
      {/* 缩略图 */}
      <div 
        className={`relative inline-block cursor-pointer group ${className}`}
        onClick={handleClick}
        style={{ width: 'auto', height: 'auto' }}
      >
        <img 
          src={displaySrc} 
          alt={alt}
          className="custom-image-thumbnail rounded-lg border border-border"
        />
        {/* 悬浮放大镜图标 */}
        <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-20 transition-all duration-200 rounded-lg flex items-center justify-center">
          <ZoomIn className="w-6 h-6 text-white opacity-0 group-hover:opacity-100 transition-opacity duration-200" />
        </div>
      </div>

      {/* 全屏模态框 */}
      {isModalOpen && (
        <div 
          className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4"
          onClick={() => setIsModalOpen(false)}
        >
          {/* 关闭按钮 */}
          <button
            className="absolute top-4 right-4 text-white hover:text-gray-300 z-10"
            onClick={() => setIsModalOpen(false)}
          >
            <X className="w-8 h-8" />
          </button>
          
          {/* 大图 */}
          <div 
            className="relative max-w-full max-h-full"
            onClick={(e) => e.stopPropagation()}
          >
            {!imageLoaded && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
              </div>
            )}
            <img 
              src={src}
              alt={alt}
              className={`max-w-full max-h-full object-contain transition-opacity duration-300 ${
                imageLoaded ? 'opacity-100' : 'opacity-0'
              }`}
              onLoad={() => setImageLoaded(true)}
            />
          </div>
        </div>
      )}
    </>
  );
}
