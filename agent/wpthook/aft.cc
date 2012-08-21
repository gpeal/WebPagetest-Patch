/******************************************************************************
Copyright (c) 2011, Google Inc.
All rights reserved.

Redistribution and use in source and binary forms, with or without 
modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice, 
      this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.
    * Neither the name of the <ORGANIZATION> nor the names of its contributors 
    may be used to endorse or promote products derived from this software 
    without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" 
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE 
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE 
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE 
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL 
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR 
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER 
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, 
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE 
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
******************************************************************************/

#include "StdAfx.h"
#include "aft.h"
#include "cximage/ximage.h"

/*-----------------------------------------------------------------------------
-----------------------------------------------------------------------------*/
AFT::AFT(DWORD minChanges, DWORD earlyCutoff, DWORD pixelChangesThreshold):
  lastImg(NULL)
  , width(0)
  , height(0)
  , pixelChangeTime(NULL)
  , firstPixelChangeTime(NULL)
  , pixelChangeCount(NULL)
  , early_cutoff(earlyCutoff)
  , min_changes(minChanges)
  , pixel_changes_threshold(pixelChangesThreshold)
{
  crop.top = 0;
  crop.left = 0;
  crop.bottom = 0;
  crop.right = 0;
  early_cutoff *= 1000; // convert from seconds to ms
}

/*-----------------------------------------------------------------------------
-----------------------------------------------------------------------------*/
AFT::~AFT(void)
{
  if( pixelChangeTime )
    free( pixelChangeTime );
  if( firstPixelChangeTime )
    free( firstPixelChangeTime );
  if( pixelChangeCount )
    free( pixelChangeCount );
}

/*-----------------------------------------------------------------------------
-----------------------------------------------------------------------------*/
void AFT::SetCrop( DWORD top, DWORD right, DWORD bottom, DWORD left )
{
  crop.top = top;
  crop.right = right;
  crop.bottom = bottom;
  crop.left = left;
}

/*-----------------------------------------------------------------------------
  Keep track of the changes as images are added
-----------------------------------------------------------------------------*/
void AFT::AddImage( CxImage * img, DWORD ms )
{
  if( img && img->IsValid() && img->GetWidth() && img->GetHeight() )
  {
    if( lastImg )
    {
      // go through each pixel and check for deltas from the previous image
      if( img->GetWidth() == width && img->GetHeight() == height )
      {
        // count the changes first to make sure it exceeds the threshold
        DWORD changeCount = 0;
        DWORD i = 0;
        for( DWORD y = crop.bottom; y < height - crop.top; y++ )
        {
          for( DWORD x = crop.left; x < width - crop.right; x++ )
          {
            RGBQUAD last = lastImg->GetPixelColor(x, y, false);
            RGBQUAD current = img->GetPixelColor(x, y, false);
            if( last.rgbBlue != current.rgbBlue ||
              last.rgbGreen != current.rgbGreen ||
              last.rgbRed != current.rgbRed )
              changeCount++;
            i++;
          }
        }

        if( changeCount > min_changes )
        {
          // this could be optimized instead of fetching each pixel
          // individually
          i = 0;
          for( DWORD y = crop.bottom; y < height - crop.top; y++ )
          {
            for( DWORD x = crop.left; x < width - crop.right; x++ )
            {
              RGBQUAD last = lastImg->GetPixelColor(x, y, false);
              RGBQUAD current = img->GetPixelColor(x, y, false);

              if( last.rgbBlue != current.rgbBlue ||
                last.rgbGreen != current.rgbGreen ||
                last.rgbRed != current.rgbRed )
              {
                pixelChangeCount[i]++;
                pixelChangeTime[i] = ms;
                if( !firstPixelChangeTime[i] )
                  firstPixelChangeTime[i] = ms;
              }

              i++;
            }
          }

          WptTrace(loglevel::kFunction,
            _T("[wpthook] AFT::CalculateAFT(): Adding video frame at %d ms, %d changes detected\n"),
            ms, changeCount);
        }
        else
          WptTrace(loglevel::kFunction,
            _T("[wpthook] AFT::CalculateAFT(): Adding video frame at %d ms, %d changes detected, below threshold of %d\n"),
            ms, changeCount, min_changes);
      }
    }
    else
    {
      // first-time setup
      width = img->GetWidth();
      height = img->GetHeight();

      pixelChangeTime = (DWORD *)malloc((width - crop.left - crop.right) *
        (height - crop.top - crop.bottom) * sizeof(DWORD));
      firstPixelChangeTime  = (DWORD *)malloc((width - crop.left - crop.right) *
        (height - crop.top - crop.bottom) * sizeof(DWORD));
      pixelChangeCount = (DWORD *)malloc((width - crop.left - crop.right) *
        (height - crop.top - crop.bottom) * sizeof(DWORD));

      memset(pixelChangeTime, 0, (width - crop.left - crop.right) *
        (height - crop.top - crop.bottom) * sizeof(DWORD));
      memset(firstPixelChangeTime, 0, (width - crop.left - crop.right) *
        (height - crop.top - crop.bottom) * sizeof(DWORD));
      memset(pixelChangeCount, 0, (width - crop.left - crop.right) *
        (height - crop.top - crop.bottom) * sizeof(DWORD));
    }

    lastImg = img;
  }
}

/*-----------------------------------------------------------------------------
  After all of the images have been added this will go through
  and look for the latest change for any pixel that isn't considered
  dynamic
-----------------------------------------------------------------------------*/
bool AFT::Calculate( DWORD &ms, bool &confident, CxImage * imgAft )
{
  bool ret = false;
  ms = 0;

  if( lastImg )
  {
    DWORD latest_of_first = 0;
    DWORD latest_of_early = 0;
    DWORD latest_of_static = 0;
    confident = true;
    bool determined = true;

    WptTrace(loglevel::kFunction,
      _T("[wpthook] AFT::Calculate():  Minimum Change Size: %d pixels, Early Cutoff: %d ms, Pixel Changes Threshold: %d\n"),
      min_changes, early_cutoff, pixel_changes_threshold);

    // create the image of the AFT algorithm
    if( imgAft )
    {
      imgAft->Create(width, height, 24);
      imgAft->Clear();
    }

    // go through the timings for each pixel
    DWORD i = 0;
    int rowPixels = (int)width - (int)(crop.left + crop.right);
    for( int y = (int)crop.bottom; y < (int)(height - crop.top); y++ )
    {
      for( int x = (int)crop.left; x < (int)(width - crop.right); x++ )
      {
        DWORD changeCount = pixelChangeCount[i];
        DWORD lastChange = pixelChangeTime[i];
        DWORD firstChange = firstPixelChangeTime[i];
        bool latest_is_early = lastChange < early_cutoff;
        bool few_changes = changeCount < pixel_changes_threshold;

        // keep track of the first change time for each pixel
        if( firstChange > latest_of_first )
          latest_of_first = firstChange;

        if( changeCount )
        {
          // late-stabelizing static pixels cause undetermined results
          if( !latest_is_early && few_changes )
          {
            determined = false;
            if(imgAft)
              imgAft->SetPixelColor(x,y, RGB(255,0,0));
          }

          // did it stabilize early (even if it was dynamic)?
          if( latest_is_early )
          {
            if( lastChange > latest_of_early )
            {
              latest_of_early = lastChange;
              WptTrace(loglevel::kFunction,
                _T("[wpthook] AFT::Calculate():Latest early updated to %d ms\n"),
                latest_of_early);
            }
            if(imgAft)
              imgAft->SetPixelColor(x,y, RGB(255,255,255));
          }

          // is it a static pixel?
          if( few_changes )
          {
            // make sure the immediately surrounding pixels are also static
            if( lastChange > latest_of_static )
            {
              bool boundary_has_few_changes = true;
              int x1 = max( x - 1, (int)crop.left);
              int x2 = min( x + 1, (int)(width - crop.right));
              int y1 = max( y - 1, (int)crop.bottom );
              int y2 = min( y + 1, (int)(height - crop.top));
              for( int yy = y1; yy <= y2; yy++ )
              {
                for( int xx = x1; xx <= x2; xx++ )
                {
                  int pixelOffest = (rowPixels * (yy - (int)crop.bottom)) +
                    (xx - (int)crop.left);
                  if( pixelOffest > 0 && 
                    pixelOffest < (int)((width - crop.left - crop.right) *
                    (height - crop.top - crop.bottom)) &&
                    pixelChangeCount[pixelOffest] >= pixel_changes_threshold )
                    boundary_has_few_changes = false;
                }
              }
              if( boundary_has_few_changes )
              {
                latest_of_static = lastChange;
                WptTrace(loglevel::kFunction,
                  _T("[wpthook] AFT::Calculate(): Latest static updated to %d ms\n"),
                  latest_of_static);
              }
            }
          }
          else if( !latest_is_early && imgAft )
            imgAft->SetPixelColor(x,y, RGB(0,0,255));
        }
        else if(imgAft)
          imgAft->SetPixelColor(x,y, RGB(0,0,0));

        i++;
      }
    }

    // ignore latest_of_first for now to stay true to the original algorithm
    if( latest_of_static == latest_of_early )
    {
      ret = true;
      ms = latest_of_early;
      confident = true;
      WptTrace(loglevel::kFunction,
        _T("[wpthook] AFT::Calculate(): AFT %d ms (high confidence)"),
        ms);
    }
    else if( determined )
    {
      ret = true;
      ms = latest_of_static;
      confident = false;
      WptTrace(loglevel::kFunction,
        _T("[wpthook] AFT::Calculate(): AFT: %d ms (stabilized - low conf)"),
        ms);
    }
    else
    {
      ret = false;
      WptTrace(loglevel::kFunction,
        _T("[wpthook] AFT::Calculate(): AFT Undetermined\n"));
    }

    // color the AFT pixels that defined the end time
    if( ms && imgAft )
    {
      DWORD i = 0;
      for( DWORD y = crop.bottom; y < height - crop.top; y++ )
      {
        for( DWORD x = crop.left; x < width - crop.right; x++ )
        {
          if( pixelChangeTime[i] == ms )
            imgAft->SetPixelColor(x,y, RGB(0,255,0));

          i++;
        }
      }
    }
  }

  return ret;
}


