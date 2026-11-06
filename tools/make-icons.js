const zlib=require('zlib'),fs=require('fs'),path=require('path');
const out=process.argv[2]||require('path').join(__dirname,'..','icons');
function crc32(b){let c,t=[];for(let n=0;n<256;n++){c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0}
 let r=0xffffffff;for(const x of b)r=t[(r^x)&255]^(r>>>8);return(r^0xffffffff)>>>0}
function chunk(type,data){const l=Buffer.alloc(4);l.writeUInt32BE(data.length);const td=Buffer.concat([Buffer.from(type),data]);
 const c=Buffer.alloc(4);c.writeUInt32BE(crc32(td));return Buffer.concat([l,td,c])}
function png(w,h,rgba){const raw=Buffer.alloc((w*4+1)*h);for(let y=0;y<h;y++){raw[y*(w*4+1)]=0;rgba.copy(raw,y*(w*4+1)+1,y*w*4,(y+1)*w*4)}
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))])}
// embudo (filtro) blanco sobre cuadrado redondeado verde
const funnel=[[.20,.26],[.80,.26],[.57,.54],[.57,.78],[.43,.70],[.43,.54]];
function inPoly(x,y,p){let c=false;for(let i=0,j=p.length-1;i<p.length;j=i++){const[xi,yi]=p[i],[xj,yj]=p[j];
 if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)c=!c}return c}
function inRound(x,y,r){const dx=Math.max(r-x,0,x-(1-r)),dy=Math.max(r-y,0,y-(1-r));return dx*dx+dy*dy<=r*r}
function draw(S){const SS=4,buf=Buffer.alloc(S*S*4);
 for(let py=0;py<S;py++)for(let px=0;px<S;px++){let bg=0,fg=0;
  for(let sy=0;sy<SS;sy++)for(let sx=0;sx<SS;sx++){const x=(px+(sx+.5)/SS)/S,y=(py+(sy+.5)/SS)/S;
   if(inRound(x,y,.22)){bg++;if(inPoly(x,y,funnel))fg++}}
  const n=SS*SS,a=bg/n;if(!bg)continue;const f=fg/bg; // mezcla blanco/verde
  const R=46+(255-46)*f,G=125+(255-125)*f,B=50+(255-50)*f,i=(py*S+px)*4;
  buf[i]=R;buf[i+1]=G;buf[i+2]=B;buf[i+3]=Math.round(a*255)}
 return png(S,S,buf)}
for(const s of[16,32,48,128])fs.writeFileSync(path.join(out,`icon${s}.png`),draw(s));
